const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BACKUP_FORMAT = 'school-meal-management-backup';
const BACKUP_VERSION = 1;
const APP_NAME = 'school-meal-management-phase1';

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function timestampForFilename(date = new Date()) {
    return date.toISOString().replace(/[-:TZ]/g, '').slice(0, 14);
}

function listFiles(rootDir, baseDir = rootDir) {
    if (!fs.existsSync(rootDir)) return [];

    return fs.readdirSync(rootDir, { withFileTypes: true }).flatMap(entry => {
        const fullPath = path.join(rootDir, entry.name);
        if (entry.isDirectory()) return listFiles(fullPath, baseDir);
        if (!entry.isFile()) return [];
        return [fullPath.slice(baseDir.length + 1).split(path.sep).join('/')];
    }).sort();
}

function buildFileEntry(root, relativePath, baseDir) {
    const fullPath = path.join(baseDir, relativePath);
    const buffer = fs.readFileSync(fullPath);
    const isJson = relativePath.toLowerCase().endsWith('.json');
    const encoding = isJson ? 'utf8' : 'base64';
    const content = buffer.toString(encoding);

    return {
        root,
        path: relativePath.split(path.sep).join('/'),
        encoding,
        size: buffer.length,
        sha256: sha256(buffer),
        content
    };
}

function createBackupPackage({ dataDir, uploadsDir, createdAt = new Date() }) {
    const files = [
        ...listFiles(dataDir).map(relativePath => buildFileEntry('data', relativePath, dataDir)),
        ...listFiles(uploadsDir).map(relativePath => buildFileEntry('uploads', relativePath, uploadsDir))
    ];

    return {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        createdAt: createdAt.toISOString(),
        source: { app: APP_NAME },
        files
    };
}

function decodeEntryContent(entry) {
    if (entry.encoding === 'utf8') return Buffer.from(entry.content, 'utf8');
    if (entry.encoding === 'base64') return Buffer.from(entry.content, 'base64');
    throw new Error(`不支持的文件编码：${entry.encoding}`);
}

function resolveBackupPath(entry, roots) {
    if (!['data', 'uploads'].includes(entry.root)) {
        throw new Error(`不支持的备份根目录：${entry.root}`);
    }
    if (!entry.path || typeof entry.path !== 'string') {
        throw new Error('备份文件路径不能为空');
    }
    if (entry.path.includes('\\') || path.posix.isAbsolute(entry.path)) {
        throw new Error(`备份文件路径不安全：${entry.path}`);
    }

    const normalized = path.posix.normalize(entry.path);
    if (normalized === '.' || normalized.startsWith('../') || normalized === '..') {
        throw new Error(`备份文件路径不安全：${entry.path}`);
    }

    const rootDir = roots[entry.root];
    const fullPath = path.resolve(rootDir, ...normalized.split('/'));
    const rootPath = path.resolve(rootDir);
    if (fullPath !== rootPath && !fullPath.startsWith(rootPath + path.sep)) {
        throw new Error(`备份文件路径越界：${entry.path}`);
    }
    return { normalized, fullPath };
}

function validateBackupPackage(backup, roots) {
    if (!backup || typeof backup !== 'object') throw new Error('备份文件格式无效');
    if (backup.format !== BACKUP_FORMAT) throw new Error('备份文件格式不匹配');
    if (backup.version !== BACKUP_VERSION) throw new Error('备份文件版本不支持');
    if (!backup.createdAt || Number.isNaN(Date.parse(backup.createdAt))) throw new Error('备份创建时间无效');
    if (!backup.source || backup.source.app !== APP_NAME) throw new Error('备份来源不匹配');
    if (!Array.isArray(backup.files)) throw new Error('备份文件清单无效');

    const seen = new Set();
    return backup.files.map(entry => {
        if (!entry || typeof entry !== 'object') throw new Error('备份文件条目无效');
        const { normalized, fullPath } = resolveBackupPath(entry, roots);
        const key = `${entry.root}:${normalized}`;
        if (seen.has(key)) throw new Error(`备份文件重复：${normalized}`);
        seen.add(key);

        const buffer = decodeEntryContent(entry);
        if (entry.size !== buffer.length) throw new Error(`备份文件大小不匹配：${normalized}`);
        if (entry.sha256 !== sha256(buffer)) throw new Error(`备份文件校验失败：${normalized}`);
        if (entry.root === 'data' && normalized.toLowerCase().endsWith('.json')) {
            JSON.parse(buffer.toString('utf8') || '[]');
        }

        return { entry: { ...entry, path: normalized }, buffer, fullPath };
    });
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function restoreBackupPackage(backup, { dataDir, uploadsDir, backupsDir }) {
    const roots = { data: dataDir, uploads: uploadsDir };
    const files = validateBackupPackage(backup, roots);

    ensureDir(backupsDir);
    const preRestoreName = `pre-restore-${timestampForFilename()}-${Date.now()}.json`;
    const preRestorePath = path.join(backupsDir, preRestoreName);
    const currentBackup = createBackupPackage({ dataDir, uploadsDir });
    fs.writeFileSync(preRestorePath, JSON.stringify(currentBackup, null, 2));

    files.forEach(file => {
        ensureDir(path.dirname(file.fullPath));
        fs.writeFileSync(file.fullPath, file.buffer);
    });

    return {
        restoredFiles: files.length,
        preRestoreBackup: `server/backups/${preRestoreName}`
    };
}

module.exports = {
    BACKUP_FORMAT,
    BACKUP_VERSION,
    APP_NAME,
    createBackupPackage,
    restoreBackupPackage,
    timestampForFilename
};
