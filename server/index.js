const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Compatibility for stale frontend pages that call /selection/* without /api.
app.use((req, res, next) => {
    if (req.url.startsWith('/selection/')) {
        req.url = `/api${req.url}`;
    }
    next();
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../public')));

function loadLocalEnv() {
    const envPath = path.join(__dirname, '../.env');
    if (!fs.existsSync(envPath)) return;

    const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
    lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex <= 0) return;

        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();
        value = value.replace(/^["']|["']$/g, '');
        if (key && process.env[key] === undefined) {
            process.env[key] = value;
        }
    });
}

loadLocalEnv();

// ============ Data File Helpers ============
const DATA_DIR = path.join(__dirname, 'data');

function readJSON(filename) {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, '[]');
    }
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data || '[]');
}

function writeJSON(filename, data) {
    const filePath = path.join(DATA_DIR, filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function httpsGet(url) {
    return new Promise((resolve, reject) => {
        https.get(url, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

// ============ Auth Middleware ============
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const {
    previousSelectionStatus,
    assertWorkflowMutable,
    validateAnnouncementPublish,
    validateRegistrationReview,
    validateCandidateSelection,
    validateShortlistSelection,
    validateVotingMetadata,
    determineVotingWinner
} = require('./selectionRules');
const { buildSelectionWorkflowDetail } = require('./selectionWorkflow');
const ocrParser = require('./ocrParser');
const {
    LICENSE_TYPES,
    LICENSE_STATUSES,
    normalizeLicenseType,
    normalizeEnterpriseLicenseInput,
    detectLicenseTypeFromText,
    validateEnterpriseLicenseInput,
    applyLicenseVersioning,
    currentEnterpriseLicenses,
    buildCredentialRows,
    attachCurrentLicensesToEnterprises,
    applyLicenseToEnterpriseRecord
} = require('./enterpriseLicenseRules');
const {
    createBackupPackage,
    restoreBackupPackage,
    timestampForFilename
} = require('./backupService');
const SECRET_KEY = 'school-meal-secret-key-2026';

function generateToken(user) {
    return jwt.sign(
        {
            id: user.id,
            username: user.username,
            name: user.name,
            role: user.role,
            schoolId: user.schoolId || ''
        },
        SECRET_KEY,
        { expiresIn: '24h' }
    );
}

function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
        return res.status(401).json({ error: '未登录' });
    }
    try {
        const decoded = jwt.verify(token, SECRET_KEY);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: '登录已过期' });
    }
}

function roleMiddleware(...roles) {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: '无权限访问' });
        }
        next();
    };
}

// ============ 学年配置 API ============
app.get('/api/config/academic-year', authMiddleware, (req, res) => {
    const config = readJSON('systemConfig.json');
    const schools = readJSON('schools.json');
    const canteens = readJSON('canteens.json');
    const ingredientSuppliers = readJSON('ingredientSuppliers.json');
    const cateringCompanies = readJSON('cateringCompanies.json');
    const operationSuppliers = readJSON('operationSuppliers.json');
    const serviceSuppliers = readJSON('serviceSuppliers.json');

    // 统计每学年的各类数据量
    const yearCounts = {};
    config.academicYears.forEach(y => {
        yearCounts[y] = {
            schoolCount: schools.filter(s => s.academicYear === y).length,
            canteenCount: canteens.filter(c => c.academicYear === y).length,
            ingredientSupplierCount: ingredientSuppliers.filter(s => s.academicYear === y).length,
            cateringCompanyCount: cateringCompanies.filter(c => c.academicYear === y).length,
            operationSupplierCount: operationSuppliers.filter(s => s.academicYear === y).length,
            serviceSupplierCount: serviceSuppliers.filter(s => s.academicYear === y).length
        };
    });

    res.json({
        currentAcademicYear: config.currentAcademicYear,
        academicYears: config.academicYears,
        yearCounts
    });
});

app.put('/api/config/academic-year', authMiddleware, roleMiddleware('admin'), (req, res) => {
    const { currentAcademicYear } = req.body;
    if (!currentAcademicYear) {
        return res.status(400).json({ error: '请指定当前学年' });
    }
    const config = readJSON('systemConfig.json');
    config.currentAcademicYear = currentAcademicYear;
    config.updatedAt = new Date().toISOString();
    writeJSON('systemConfig.json', config);
    res.json(config);
});

app.post('/api/config/academic-year', authMiddleware, roleMiddleware('admin'), (req, res) => {
    const { newAcademicYear, copyFromYear } = req.body;
    if (!newAcademicYear) {
        return res.status(400).json({ error: '请指定新学年' });
    }
    const config = readJSON('systemConfig.json');

    // 添加新学年到列表
    if (!config.academicYears.includes(newAcademicYear)) {
        config.academicYears.unshift(newAcademicYear); // 新学年放在最前面
    }
    config.currentAcademicYear = newAcademicYear;
    config.updatedAt = new Date().toISOString();
    writeJSON('systemConfig.json', config);

    // 如果指定了复制学年，复制学校和食堂及供应商数据
    if (copyFromYear) {
        const schools = readJSON('schools.json');
        const canteens = readJSON('canteens.json');
        const ingredientSuppliers = readJSON('ingredientSuppliers.json');
        const cateringCompanies = readJSON('cateringCompanies.json');
        const operationSuppliers = readJSON('operationSuppliers.json');
        const serviceSuppliers = readJSON('serviceSuppliers.json');

        // 复制学校数据（排除已有新学年数据的学校）
        const newSchools = schools.filter(s => s.academicYear === copyFromYear).map(s => ({
            ...s,
            id: s.id + '_' + newAcademicYear,
            academicYear: newAcademicYear,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        }));

        const existingNewSchools = schools.filter(s => s.academicYear === newAcademicYear);
        const existingIds = new Set(existingNewSchools.map(s => s.code));

        const schoolsToAdd = newSchools.filter(s => !existingIds.has(s.code));
        writeJSON('schools.json', [...schools, ...schoolsToAdd]);

        // 复制食堂数据
        const newCanteens = canteens.filter(c => c.academicYear === copyFromYear).map(c => ({
            ...c,
            id: c.id + '_' + newAcademicYear,
            academicYear: newAcademicYear,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        }));

        const existingNewCanteens = canteens.filter(c => c.academicYear === newAcademicYear);
        const existingCanteenIds = new Set(existingNewCanteens.map(c => c.code));

        const canteensToAdd = newCanteens.filter(c => !existingCanteenIds.has(c.code));
        writeJSON('canteens.json', [...canteens, ...canteensToAdd]);

        // 复制供应商数据（食材供应商、校外供餐、委托经营、委托服务）
        const copySuppliers = (list, prefix) => {
            const newList = list.filter(s => s.academicYear === copyFromYear).map(s => ({
                ...s,
                id: prefix + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                academicYear: newAcademicYear,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            }));
            const existingNew = list.filter(s => s.academicYear === newAcademicYear);
            const existingCodes = new Set(existingNew.map(s => s.code));
            return newList.filter(s => !existingCodes.has(s.code));
        };

        const ingToAdd = copySuppliers(ingredientSuppliers, 'ing_');
        const catToAdd = copySuppliers(cateringCompanies, 'catering_');
        const opToAdd = copySuppliers(operationSuppliers, 'op_');
        const svcToAdd = copySuppliers(serviceSuppliers, 'svc_');

        if (ingToAdd.length) writeJSON('ingredientSuppliers.json', [...ingredientSuppliers, ...ingToAdd]);
        if (catToAdd.length) writeJSON('cateringCompanies.json', [...cateringCompanies, ...catToAdd]);
        if (opToAdd.length) writeJSON('operationSuppliers.json', [...operationSuppliers, ...opToAdd]);
        if (svcToAdd.length) writeJSON('serviceSuppliers.json', [...serviceSuppliers, ...svcToAdd]);

        res.json({
            message: '新学年已创建并复制了上一学年数据',
            newAcademicYear,
            schoolsAdded: schoolsToAdd.length,
            canteensAdded: canteensToAdd.length,
            ingredientSuppliersAdded: ingToAdd.length,
            cateringCompaniesAdded: catToAdd.length,
            operationSuppliersAdded: opToAdd.length,
            serviceSuppliersAdded: svcToAdd.length
        });
    } else {
        res.json({ message: '新学年已创建', newAcademicYear });
    }
});

// ============ OCR 配置 ============
const OCR_CONFIG = {
    // 百度OCR配置：优先读取环境变量，未配置时使用这里的默认值。
    baidu: {
        apiKey: process.env.BAIDU_OCR_API_KEY || 'DhDXlfEbGA2M70YKsD6tNXBB',
        secretKey: process.env.BAIDU_OCR_SECRET_KEY || 'wcQMhG48KzOLMJWYOY1PbsBIwVPcNR9X',
        enabled: true  // 设置为 true 启用百度OCR
    },
    // 腾讯OCR配置
    tencent: {
        secretId: '',   // 替换为您的 SecretId
        secretKey: '',   // 替换为您的 SecretKey
        enabled: false   // 设置为 true 启用腾讯OCR
    }
};

const BAIDU_OCR_ENDPOINTS = {
    businessLicense: 'https://aip.baidubce.com/rest/2.0/ocr/v1/business_license',
    foodBusinessLicense: 'https://aip.baidubce.com/rest/2.0/ocr/v1/food_business_license',
    accurateBasic: 'https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic',
    generalBasic: 'https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic'
};

let baiduTokenCache = {
    accessToken: '',
    expiresAt: 0
};

// 获取百度Access Token
async function getBaiduAccessToken() {
    if (!OCR_CONFIG.baidu.apiKey || !OCR_CONFIG.baidu.secretKey) {
        throw new Error('百度OCR未配置密钥');
    }

    if (baiduTokenCache.accessToken && Date.now() < baiduTokenCache.expiresAt) {
        return baiduTokenCache.accessToken;
    }

    const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: OCR_CONFIG.baidu.apiKey,
        client_secret: OCR_CONFIG.baidu.secretKey
    });
    const url = `https://aip.baidubce.com/oauth/2.0/token?${params.toString()}`;
    const res = await fetch(url, { method: 'POST' });
    const data = await res.json();
    if (data.access_token) {
        const expiresInMs = Math.max(Number(data.expires_in || 0) - 300, 0) * 1000;
        baiduTokenCache = {
            accessToken: data.access_token,
            expiresAt: Date.now() + expiresInMs
        };
        return data.access_token;
    }
    throw new Error(data.error_description || '获取百度Access Token失败');
}

async function getOcrImageBase64({ imageUrl, imageBase64 }) {
    if (imageBase64) {
        return imageBase64.includes(',') ? imageBase64.split(',').pop() : imageBase64;
    }
    if (!imageUrl) {
        throw new Error('请提供图片URL或Base64数据');
    }

    const fullUrl = imageUrl.startsWith('http') ? imageUrl : `http://localhost:${PORT}${imageUrl}`;
    const imgRes = await fetch(fullUrl);
    if (!imgRes.ok) {
        throw new Error('读取证照图片失败');
    }
    const imgBuffer = await imgRes.arrayBuffer();
    return Buffer.from(imgBuffer).toString('base64');
}

async function callBaiduOcr(endpointUrl, imageData, extraParams = {}) {
    const accessToken = await getBaiduAccessToken();
    const params = new URLSearchParams({ image: imageData, ...extraParams });
    const ocrRes = await fetch(`${endpointUrl}?access_token=${encodeURIComponent(accessToken)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });
    const ocrData = await ocrRes.json();
    if (ocrData.error_code) {
        const err = new Error(ocrData.error_msg || 'OCR识别失败');
        err.ocrData = ocrData;
        throw err;
    }
    return ocrData;
}

// ============ Routes ============

// --- Auth ---
app.post('/api/auth/login', (req, res) => {
    const { username, password, role } = req.body;
    const users = readJSON('users.json');

    // Password is "123456" for demo
    const user = users.find(u => u.username === username);
    if (!user) {
        return res.status(401).json({ error: '用户名或密码错误' });
    }

    // For demo, accept "123456" as password
    console.log('DEBUG login attempt:', username, '|', password, '| hash:', user ? user.password.substring(0, 30) : 'no user');
    if (!bcrypt.compareSync(password, user.password)) {
        return res.status(401).json({ error: '用户名或密码错误' });
    }

    const token = generateToken(user);
    res.json({
        token,
        user: {
            id: user.id,
            username: user.username,
            name: user.name,
            role: user.role,
            region: user.region,
            schoolId: user.schoolId || ''
        }
    });
});

app.post('/api/auth/forgot-password', (req, res) => {
    const { username, role, name, newPassword } = req.body;
    if (!username || !role || !name || !newPassword) {
        return res.status(400).json({ error: '请填写用户名、身份、单位/姓名和新密码' });
    }
    if (String(newPassword).length < 6) {
        return res.status(400).json({ error: '新密码长度不能少于 6 位' });
    }

    const users = readJSON('users.json');
    const userIndex = users.findIndex(u => u.username === username);
    const user = users[userIndex];
    const roleMatched = user && (
        user.role === role ||
        (role === 'enterprise' && ['enterprise', 'ingredientSupplier', 'cateringCompany', 'operationSupplier', 'serviceSupplier'].includes(user.role))
    );

    if (!user || !roleMatched || user.name !== name) {
        return res.status(400).json({ error: '账号信息校验失败，请确认身份、用户名和单位/姓名' });
    }

    users[userIndex].password = bcrypt.hashSync(newPassword, 10);
    users[userIndex].passwordUpdatedAt = new Date().toISOString();
    writeJSON('users.json', users);
    res.json({ message: '密码已重置，请使用新密码登录' });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
    const users = readJSON('users.json');
    const user = users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    res.json({ id: user.id, username: user.username, name: user.name, role: user.role, region: user.region });
});

app.post('/api/auth/register', (req, res) => {
    const users = readJSON('users.json');
    const { username, password, role, name, region } = req.body;

    if (users.find(u => u.username === username)) {
        return res.status(400).json({ error: '用户名已存在' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    const newUser = {
        id: 'user_' + Date.now(),
        username,
        password: hashedPassword,
        role,
        name,
        region: region || ''
    };
    users.push(newUser);
    writeJSON('users.json', users);
    res.json({ message: '注册成功' });
});

// --- User Management (Admin) ---
app.get('/api/users', authMiddleware, roleMiddleware('admin'), (req, res) => {
    const users = readJSON('users.json');
    // Return users without password field
    const safeUsers = users.map(u => {
        const { password, ...rest } = u;
        return rest;
    });
    res.json(safeUsers);
});

app.post('/api/users', authMiddleware, roleMiddleware('admin'), (req, res) => {
    const users = readJSON('users.json');
    const { username, name, role, region, schoolId } = req.body;

    if (users.find(u => u.username === username)) {
        return res.status(400).json({ error: '用户名已存在' });
    }

    const hashedPassword = bcrypt.hashSync('123456', 10);
    const userId = 'user_' + Date.now();
    const newUser = {
        id: userId,
        username,
        password: hashedPassword,
        name: name || username,
        role,
        region: region || '',
        schoolId: schoolId || '',
        createdAt: new Date().toISOString()
    };
    users.push(newUser);
    writeJSON('users.json', users);

    // 如果是学校用户，同时创建对应的学校记录
    if (role === 'school') {
        const config = readJSON('systemConfig.json');
        const schools = readJSON('schools.json');
        const newSchool = {
            id: userId,
            name: name || username,
            code: username,
            供餐类型: [],
            region: region || '',
            contact: '',
            phone: '',
            studentCount: 0,
            staffCount: 0,
            canteenCount: 0,
            academicYear: config.currentAcademicYear || '',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        schools.push(newSchool);
        writeJSON('schools.json', schools);
    }

    // 如果是企业用户，同时创建对应的企业记录
    if (['ingredientSupplier', 'cateringCompany', 'operationSupplier', 'serviceSupplier'].includes(role)) {
        const supplierDataMap = {
            ingredientSupplier: { file: 'ingredientSuppliers.json', idPrefix: 'ing_' },
            cateringCompany: { file: 'cateringCompanies.json', idPrefix: 'cat_' },
            operationSupplier: { file: 'operationSuppliers.json', idPrefix: 'ops_' },
            serviceSupplier: { file: 'serviceSuppliers.json', idPrefix: 'svc_' }
        };
        const config = supplierDataMap[role];
        if (config) {
            const suppliers = readJSON(config.file);
            const newSupplier = {
                id: config.idPrefix + Date.now(),
                userId: newUser.id, // 关联到用户记录
                name: name || username,
                code: '',
                companyType: '有限责任公司',
                region: region || '',
                address: '',
                legalPerson: '',
                phone: '',
                capital: '',
                establishDate: '',
                businessScope: ''
            };
            // 根据类型添加特有字段
            if (role === 'ingredientSupplier') {
                newSupplier.mainProducts = '';
            } else if (role === 'cateringCompany') {
                newSupplier.dailyCapacity = '';
                newSupplier.currentSupply = 0;
                newSupplier.应急备选企业 = '否';
            } else if (role === 'operationSupplier') {
                newSupplier.operatedCanteens = '';
            }
            const sysConfig = readJSON('systemConfig.json');
            newSupplier.academicYear = sysConfig.currentAcademicYear || '';
            newSupplier.createdAt = new Date().toISOString();
            newSupplier.updatedAt = new Date().toISOString();
            suppliers.push(newSupplier);
            writeJSON(config.file, suppliers);
        }
    }

    res.json({ ...newUser, password: undefined });
});

app.put('/api/users/:id', authMiddleware, roleMiddleware('admin'), (req, res) => {
    const users = readJSON('users.json');
    const idx = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '用户不存在' });

    const { name, role, region, password, schoolId } = req.body;
    users[idx] = {
        ...users[idx],
        name: name !== undefined ? name : users[idx].name,
        role: role !== undefined ? role : users[idx].role,
        region: region !== undefined ? region : users[idx].region,
        schoolId: schoolId !== undefined ? schoolId : users[idx].schoolId
    };
    if (password) {
        users[idx].password = bcrypt.hashSync(password, 10);
    }
    writeJSON('users.json', users);
    res.json({ ...users[idx], password: undefined });
});

app.delete('/api/users/:id', authMiddleware, roleMiddleware('admin'), (req, res) => {
    const users = readJSON('users.json');
    if (users.length <= 1) return res.status(400).json({ error: '不能删除最后一个管理员账户' });
    const idx = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '用户不存在' });
    if (users[idx].role === 'admin') return res.status(400).json({ error: '不能删除管理员账户' });
    const filtered = users.filter(u => u.id !== req.params.id);
    writeJSON('users.json', filtered);
    res.json({ message: '删除成功' });
});

app.post('/api/users/reset-password/:id', authMiddleware, roleMiddleware('admin'), (req, res) => {
    const users = readJSON('users.json');
    const idx = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '用户不存在' });
    users[idx].password = bcrypt.hashSync('123456', 10);
    writeJSON('users.json', users);
    res.json({ message: '密码已重置为 123456' });
});

app.post('/api/users/batch-import', authMiddleware, roleMiddleware('admin'), (req, res) => {
    const users = readJSON('users.json');
    let newUsers = [];

    // Check if it's a file upload (Excel)
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data') || req.body.users === undefined) {
        // File upload handled separately below with multer
        return res.status(400).json({ error: '请使用表单方式上传 Excel 文件' });
    }

    // JSON format
    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        newUsers = body.users;
    } catch (e) {
        return res.status(400).json({ error: 'JSON 格式错误' });
    }

    if (!Array.isArray(newUsers)) {
        return res.status(400).json({ error: '数据格式错误' });
    }

    const results = processBatch(users, newUsers);
    writeJSON('users.json', users);
    res.json(results);
});

// Multer setup for file upload
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

app.get('/api/system/backup', authMiddleware, roleMiddleware('admin'), (req, res) => {
    try {
        const backup = createBackupPackage({
            dataDir: DATA_DIR,
            uploadsDir: path.join(__dirname, 'uploads')
        });
        const filename = `school-meal-backup-${timestampForFilename()}.json`;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.json(backup);
    } catch (err) {
        res.status(500).json({ error: err.message || '备份生成失败' });
    }
});

app.post('/api/system/restore', authMiddleware, roleMiddleware('admin'), upload.single('file'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: '请选择备份文件' });

        let backup;
        try {
            backup = JSON.parse(req.file.buffer.toString('utf8'));
        } catch (err) {
            return res.status(400).json({ error: '备份文件不是有效的 JSON' });
        }

        const result = restoreBackupPackage(backup, {
            dataDir: DATA_DIR,
            uploadsDir: path.join(__dirname, 'uploads'),
            backupsDir: path.join(__dirname, 'backups')
        });
        res.json({ message: '恢复成功', ...result });
    } catch (err) {
        res.status(400).json({ error: err.message || '恢复失败' });
    }
});

app.post('/api/users/batch-import-file', upload.single('file'), authMiddleware, roleMiddleware('admin'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: '请上传 Excel 文件' });
    }

    const XLSX = require('xlsx');
    let workbook;
    try {
        workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    } catch (e) {
        return res.status(400).json({ error: '无法解析 Excel 文件，请确认文件格式正确' });
    }

    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    if (jsonData.length < 2) {
        return res.status(400).json({ error: 'Excel 文件为空或没有数据行' });
    }

    // First row is header: username, name, role, region
    const headers = jsonData[0].map(h => String(h).trim().toLowerCase());
    const usernameIdx = headers.findIndex(h => h.includes('username') || h.includes('用户名'));
    const nameIdx = headers.findIndex(h => h.includes('name') || h.includes('名称'));
    const roleIdx = headers.findIndex(h => h.includes('role') || h.includes('角色'));
    const regionIdx = headers.findIndex(h => h.includes('region') || h.includes('区域'));

    if (usernameIdx === -1) {
        return res.status(400).json({ error: 'Excel 必须包含 "username" 或 "用户名" 列' });
    }

    const users = readJSON('users.json');
    const results = { success: 0, failed: 0, errors: [] };
    const hashedPassword = bcrypt.hashSync('123456', 10);

    for (let i = 1; i < jsonData.length; i++) {
        const row = jsonData[i];
        const username = String(row[usernameIdx] || '').trim();
        if (!username) {
            results.errors.push(`第 ${i + 1} 行：用户名为空`);
            results.failed++;
            continue;
        }
        if (users.find(u => u.username === username)) {
            results.errors.push(`第 ${i + 1} 行：用户名 "${username}" 已存在`);
            results.failed++;
            continue;
        }
        const userRole = normalizeRole(roleIdx >= 0 ? String(row[roleIdx] || 'school').trim() : 'school');
        const userName = nameIdx >= 0 ? String(row[nameIdx] || username).trim() : username;
        const userRegion = regionIdx >= 0 ? String(row[regionIdx] || '').trim() : '';
        const userId = 'user_' + Date.now() + '_' + i;
        const user = {
            id: userId,
            username,
            password: hashedPassword,
            name: userName,
            role: userRole,
            region: userRegion,
            createdAt: new Date().toISOString()
        };
        users.push(user);

        // 如果是学校用户，同时创建对应的学校记录
        if (userRole === 'school') {
            const schools = readJSON('schools.json');
            schools.push({
                id: userId,
                name: userName,
                code: username,
                供餐类型: [],
                region: userRegion,
                contact: '',
                phone: '',
                studentCount: 0,
                staffCount: 0,
                canteenCount: 0,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });
            writeJSON('schools.json', schools);
        }
        results.success++;
    }

    writeJSON('users.json', users);
    res.json(results);
});

function normalizeRole(roleStr) {
    const map = {
        'school': 'school',
        '学校': 'school',
        '学校用户': 'school',
        'ingredientSupplier': 'ingredientSupplier',
        '食材供应商': 'ingredientSupplier',
        'cateringCompany': 'cateringCompany',
        '校外供餐企业': 'cateringCompany',
        'operationSupplier': 'operationSupplier',
        '委托经营供应商': 'operationSupplier',
        'serviceSupplier': 'serviceSupplier',
        '委托服务提供商': 'serviceSupplier',
        'admin': 'admin',
        '管理员': 'admin',
        '市级管理员': 'admin'
    };
    return map[roleStr] || 'school';
}

function processBatch(users, newUsers) {
    const results = { success: 0, failed: 0, errors: [] };
    const hashedPassword = bcrypt.hashSync('123456', 10);

    newUsers.forEach((item, index) => {
        if (!item.username) {
            results.failed++;
            results.errors.push(`第 ${index + 1} 行：用户名为空`);
            return;
        }
        if (users.find(u => u.username === item.username)) {
            results.failed++;
            results.errors.push(`第 ${index + 1} 行：用户名 "${item.username}" 已存在`);
            return;
        }
        const userRole = normalizeRole(item.role || 'school');
        const userId = 'user_' + Date.now() + '_' + index;
        const user = {
            id: userId,
            username: item.username,
            password: hashedPassword,
            name: item.name || item.username,
            role: userRole,
            region: item.region || '',
            createdAt: new Date().toISOString()
        };
        users.push(user);

        // 如果是学校用户，同时创建对应的学校记录
        if (userRole === 'school') {
            const schools = readJSON('schools.json');
            schools.push({
                id: userId,
                name: item.name || item.username,
                code: item.username,
                供餐类型: [],
                region: item.region || '',
                contact: '',
                phone: '',
                studentCount: 0,
                staffCount: 0,
                canteenCount: 0,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });
            writeJSON('schools.json', schools);
        }
        results.success++;
    });
    return results;
}

// --- Schools ---
app.get('/api/schools', authMiddleware, (req, res) => {
    let schools = readJSON('schools.json');
    // 按学年筛选
    const academicYear = req.query.academicYear;
    if (academicYear) {
        schools = schools.filter(s => s.academicYear === academicYear);
    }
    // 学校用户只能看本校
    if (req.user.role === 'school' && req.user.schoolId) {
        schools = schools.filter(s => s.id === req.user.schoolId);
    }
    sendListResponse(req, res, schools, ['name', 'code', 'region', 'type']);
});

// 获取所有学年
app.get('/api/schools/years', authMiddleware, (req, res) => {
    const schools = readJSON('schools.json');
    const years = [...new Set(schools.map(s => s.academicYear).filter(Boolean))].sort().reverse();
    res.json(years);
});

// 导出学校Excel
app.get('/api/schools/export', authMiddleware, (req, res) => {
    let schools = readJSON('schools.json');
    if (req.query.academicYear) schools = schools.filter(s => s.academicYear === req.query.academicYear);
    if (req.user.role === 'school' && req.user.schoolId) schools = schools.filter(s => s.id === req.user.schoolId);
    const rows = applyListQuery(schools, { ...req.query, page: 1, pageSize: Number.MAX_SAFE_INTEGER }, ['name', 'code', 'region', 'type']).data
        .map(s => ({
            code: s.code || '',
            name: s.name || '',
            type: s.type || '',
            serviceType: Array.isArray(s.供餐类型) ? s.供餐类型.join('、') : (s.供餐类型 || ''),
            region: s.region || '',
            address: s.address || '',
            contact: s.contact || '',
            phone: s.phone || '',
            studentCount: s.studentCount || 0,
            staffCount: s.staffCount || 0,
            canteenCount: s.canteenCount || 0
        }));
    exportExcel(res, '学校信息导出', '学校信息', [
        { key: 'code', label: '学校代码', width: 16 },
        { key: 'name', label: '学校名称', width: 26 },
        { key: 'type', label: '学校类型', width: 12 },
        { key: 'serviceType', label: '供餐类型', width: 18 },
        { key: 'region', label: '所在区域', width: 14 },
        { key: 'address', label: '详细地址', width: 32 },
        { key: 'contact', label: '联系人', width: 12 },
        { key: 'phone', label: '联系电话', width: 16 },
        { key: 'studentCount', label: '学生人数', width: 12 },
        { key: 'staffCount', label: '教职工人数', width: 12 },
        { key: 'canteenCount', label: '食堂数量', width: 12 }
    ], rows);
});

app.get('/api/schools/export-legacy', authMiddleware, roleMiddleware('admin'), (req, res) => {
    const schools = readJSON('schools.json');
    const XLSX = require('xlsx');

    // 表头
    const headers = ['学校代码', '学校名称', '学校类型', '供餐类型', '所在区域', '详细地址', '联系人', '联系电话', '学生人数', '教职工人数', '食堂数量', '是否为营养改善计划学校', '主管部门', '分管领导', '膳食经费账户开户行', '膳食经费账户'];

    // 数据行
    const rows = schools.map(s => [
        s.code || '',
        s.name || '',
        s.type || '',
        Array.isArray(s.供餐类型) ? s.供餐类型.join('，') : (s.供餐类型 || ''),
        s.region || '',
        s.address || '',
        s.contact || '',
        s.phone || '',
        s.studentCount || 0,
        s.staffCount || 0,
        s.canteenCount || 0,
        s.营养改善计划 || '否',
        s.department || '',
        s.leader || '',
        s.bankName || '',
        s.bankAccount || ''
    ]);

    const data = [headers, ...rows];
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '学校信息');

    // 设置列宽
    ws['!cols'] = [
        { wch: 15 }, { wch: 25 }, { wch: 10 }, { wch: 15 },
        { wch: 12 }, { wch: 30 }, { wch: 10 }, { wch: 15 },
        { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 15 },
        { wch: 20 }, { wch: 10 }, { wch: 25 }, { wch: 20 }
    ];

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = '学校信息导出_' + new Date().toISOString().split('T')[0] + '.xlsx';

    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
});

// ============ 地图坐标接口 ============
const AMAP_KEY = '3d9c04680e4e1a9e62dcda1f1c6a49ec';

// 通用geocoding函数
function geocodeAddress(address) {
    return new Promise((resolve, reject) => {
        const url = `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(address)}&key=${AMAP_KEY}`;
        httpsGet(url).then(data => {
            if (data.status === '1' && data.geocodes && data.geocodes.length > 0) {
                const loc = data.geocodes[0].location.split(',');
                resolve({ lng: parseFloat(loc[0]), lat: parseFloat(loc[1]) });
            } else {
                resolve(null);
            }
        }).catch(reject);
    });
}

// 获取有坐标的学校
app.get('/api/schools/with-coords', authMiddleware, (req, res) => {
    const schools = readJSON('schools.json');
    const result = schools.filter(s => s.lng && s.lat);
    res.json(result);
});

// 获取有坐标的校外供餐企业
app.get('/api/catering-companies/with-coords', authMiddleware, (req, res) => {
    const companies = readJSON('cateringCompanies.json');
    const result = companies.filter(c => c.lng && c.lat);
    res.json(result);
});

// 获取有坐标的食材供应商
app.get('/api/ingredient-suppliers/with-coords', authMiddleware, (req, res) => {
    const suppliers = readJSON('ingredientSuppliers.json');
    const result = suppliers.filter(s => s.lng && s.lat);
    res.json(result);
});

// 通用坐标更新接口
app.put('/api/geocode/:type/:id', authMiddleware, roleMiddleware('admin'), async (req, res) => {
    const { type, id } = req.params;
    const fileMap = {
        'school': 'schools.json',
        'ingredientSupplier': 'ingredientSuppliers.json',
        'cateringCompany': 'cateringCompanies.json',
        'operationSupplier': 'operationSuppliers.json',
        'serviceSupplier': 'serviceSuppliers.json'
    };
    const file = fileMap[type];
    if (!file) return res.status(400).json({ error: '无效的类型' });

    const data = readJSON(file);
    const idx = data.findIndex(item => item.id === id);
    if (idx === -1) return res.status(404).json({ error: '记录不存在' });

    const address = data[idx].address || data[idx].foodLicenseAddress;
    if (!address) return res.status(400).json({ error: '地址为空，无法获取坐标' });

    const coords = await geocodeAddress(address);
    if (!coords) return res.status(400).json({ error: '无法获取坐标，请检查地址是否正确' });

    data[idx].lng = coords.lng.toString();
    data[idx].lat = coords.lat.toString();
    writeJSON(file, data);

    res.json({ success: true, ...coords });
});

app.get('/api/schools/:id', authMiddleware, (req, res) => {
    const schools = readJSON('schools.json');
    const school = schools.find(s => s.id === req.params.id);
    if (!school) return res.status(404).json({ error: '学校不存在' });
    // 学校用户不能查看其他学校
    if (req.user.role === 'school' && req.user.schoolId !== school.id) {
        return res.status(403).json({ error: '无权查看此学校' });
    }
    res.json(school);
});

app.post('/api/schools', authMiddleware, (req, res) => {
    const schools = readJSON('schools.json');
    const config = readJSON('systemConfig.json');
    const school = {
        id: 'school_' + Date.now(),
        ...req.body,
        academicYear: req.body.academicYear || config.currentAcademicYear,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    schools.push(school);
    writeJSON('schools.json', schools);

    // Create default user for school
    if (req.body.username && req.body.password) {
        const users = readJSON('users.json');
        const hashedPassword = bcrypt.hashSync(req.body.password, 10);
        users.push({
            id: school.id,
            username: req.body.username,
            password: hashedPassword,
            role: 'school',
            name: req.body.name,
            region: req.body.region,
            schoolId: school.id
        });
        writeJSON('users.json', users);
    }

    res.json(school);
});

// 批量导入学校
app.post('/api/schools/batch-import', authMiddleware, roleMiddleware('admin'), (req, res) => {
    const { schools } = req.body;
    if (!Array.isArray(schools)) {
        return res.status(400).json({ error: '数据必须是数组格式' });
    }

    const existingSchools = readJSON('schools.json');
    const results = { success: 0, failed: 0, errors: [] };

    for (let i = 0; i < schools.length; i++) {
        const s = schools[i];
        const name = String(s.name || s.学校名称 || '').trim();
        const code = String(s.code || s.学校代码 || name || '').trim();

        if (!name) {
            results.errors.push(`第 ${i + 1} 行：学校名称为空`);
            results.failed++;
            continue;
        }

        // 检查是否已存在
        if (existingSchools.find(existing => existing.name === name || existing.code === code)) {
            results.errors.push(`第 ${i + 1} 行：学校 "${name}" 已存在`);
            results.failed++;
            continue;
        }

        // 解析供餐类型
        let 供餐类型 = [];
        if (s.供餐类型 || s.serviceType) {
            const typeStr = String(s.供餐类型 || s.serviceType || '');
            供餐类型 = typeStr.split(/[,，/]/).map(t => t.trim()).filter(t => t);
        }

        const schoolId = 'school_' + Date.now() + '_' + (i + 1);
        const school = {
            id: schoolId,
            name,
            code,
            type: String(s.type || s.学校类型 || '').trim(),
            供餐类型,
            region: String(s.region || s.所在区域 || '').trim(),
            address: String(s.address || s.详细地址 || '').trim(),
            contact: String(s.contact || s.联系人 || '').trim(),
            phone: String(s.phone || s.联系电话 || '').trim(),
            studentCount: parseInt(s.studentCount || s.学生人数) || 0,
            staffCount: parseInt(s.staffCount || s.教职工人数) || 0,
            canteenCount: parseInt(s.canteenCount || s.食堂数量) || 0,
            营养改善计划: String(s.营养改善计划 || s['是否为营养改善计划学校'] || '否').trim(),
            department: String(s.department || s.主管部门 || '').trim(),
            leader: String(s.leader || s.分管领导 || '').trim(),
            bankName: String(s.bankName || s.膳食经费账户开户行 || '').trim(),
            bankAccount: String(s.bankAccount || s.膳食经费账户 || '').trim(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        existingSchools.push(school);
        results.success++;
    }

    writeJSON('schools.json', existingSchools);
    res.json(results);
});

// 批量导入学校（Excel文件）
app.post('/api/schools/batch-import-file', upload.single('file'), authMiddleware, roleMiddleware('admin'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: '请上传 Excel 文件' });
    }

    const XLSX = require('xlsx');
    let workbook;
    try {
        workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    } catch (e) {
        return res.status(400).json({ error: '无法解析 Excel 文件，请确认文件格式正确' });
    }

    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    if (jsonData.length < 2) {
        return res.status(400).json({ error: 'Excel 文件为空或没有数据行' });
    }

    // PRD字段映射
    const headers = jsonData[0].map(h => String(h).trim());
    const nameIdx = headers.findIndex(h => h.includes('名称') || h.includes('name'));
    const codeIdx = headers.findIndex(h => h.includes('代码') || h.includes('code'));
    const typeIdx = headers.findIndex(h => h.includes('类型') || h.includes('type'));
    const serviceTypeIdx = headers.findIndex(h => h.includes('供餐类型'));
    const regionIdx = headers.findIndex(h => h.includes('区域') || h.includes('region'));
    const addressIdx = headers.findIndex(h => h.includes('地址') || h.includes('address'));
    const contactIdx = headers.findIndex(h => h.includes('联系人') || h.includes('contact'));
    const phoneIdx = headers.findIndex(h => h.includes('电话') || h.includes('phone'));
    const studentIdx = headers.findIndex(h => h.includes('学生') || h.includes('student'));
    const staffIdx = headers.findIndex(h => h.includes('教职工') || h.includes('staff'));
    const canteenIdx = headers.findIndex(h => h.includes('食堂') || h.includes('canteen'));
    const nutritionIdx = headers.findIndex(h => h.includes('营养改善计划'));
    const deptIdx = headers.findIndex(h => h.includes('主管部门') || h.includes('department'));
    const leaderIdx = headers.findIndex(h => h.includes('分管领导') || h.includes('leader'));
    const bankNameIdx = headers.findIndex(h => h.includes('开户行'));
    const bankAccountIdx = headers.findIndex(h => h.includes('账户') && !h.includes('开户行'));

    if (nameIdx === -1) {
        return res.status(400).json({ error: 'Excel 必须包含 "学校名称" 列' });
    }

    const existingSchools = readJSON('schools.json');
    const results = { success: 0, failed: 0, errors: [] };

    for (let i = 1; i < jsonData.length; i++) {
        const row = jsonData[i];
        const name = String(row[nameIdx] || '').trim();
        const code = codeIdx >= 0 ? String(row[codeIdx] || name).trim() : name;

        if (!name) {
            results.errors.push(`第 ${i + 1} 行：学校名称为空`);
            results.failed++;
            continue;
        }

        // 检查是否已存在
        if (existingSchools.find(existing => existing.name === name || existing.code === code)) {
            results.errors.push(`第 ${i + 1} 行：学校 "${name}" 已存在`);
            results.failed++;
            continue;
        }

        // 解析供餐类型（支持多种分隔符）
        const serviceTypeStr = serviceTypeIdx >= 0 ? String(row[serviceTypeIdx] || '') : '';
        const 供餐类型 = serviceTypeStr.split(/[,，/]/).map(t => t.trim()).filter(t => t);

        const schoolId = 'school_' + Date.now() + '_' + i;
        const school = {
            id: schoolId,
            name,
            code,
            type: typeIdx >= 0 ? String(row[typeIdx] || '').trim() : '',
            供餐类型,
            region: regionIdx >= 0 ? String(row[regionIdx] || '').trim() : '',
            address: addressIdx >= 0 ? String(row[addressIdx] || '').trim() : '',
            contact: contactIdx >= 0 ? String(row[contactIdx] || '').trim() : '',
            phone: phoneIdx >= 0 ? String(row[phoneIdx] || '').trim() : '',
            studentCount: studentIdx >= 0 ? parseInt(row[studentIdx]) || 0 : 0,
            staffCount: staffIdx >= 0 ? parseInt(row[staffIdx]) || 0 : 0,
            canteenCount: canteenIdx >= 0 ? parseInt(row[canteenIdx]) || 0 : 0,
            营养改善计划: nutritionIdx >= 0 ? String(row[nutritionIdx] || '否').trim() : '否',
            department: deptIdx >= 0 ? String(row[deptIdx] || '').trim() : '',
            leader: leaderIdx >= 0 ? String(row[leaderIdx] || '').trim() : '',
            bankName: bankNameIdx >= 0 ? String(row[bankNameIdx] || '').trim() : '',
            bankAccount: bankAccountIdx >= 0 ? String(row[bankAccountIdx] || '').trim() : '',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        existingSchools.push(school);
        results.success++;
    }

    writeJSON('schools.json', existingSchools);
    res.json(results);
});

app.put('/api/schools/:id', authMiddleware, async (req, res) => {
    const schools = readJSON('schools.json');
    const idx = schools.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '学校不存在' });
    // 学校用户只能修改本校
    if (req.user.role === 'school' && req.user.schoolId !== req.params.id) {
        return res.status(403).json({ error: '无权修改此学校' });
    }
    const oldSchool = schools[idx];
    const newData = req.body;
    // 如果地址发生变化，自动更新坐标
    if (newData.address && newData.address !== oldSchool.address) {
        const coords = await geocodeAddress(newData.address);
        if (coords) {
            newData.lng = coords.lng.toString();
            newData.lat = coords.lat.toString();
        }
    }
    schools[idx] = { ...oldSchool, ...newData, updatedAt: new Date().toISOString() };
    writeJSON('schools.json', schools);
    res.json(schools[idx]);
});

app.delete('/api/schools/:id', authMiddleware, (req, res) => {
    // 学校用户不允许删除学校
    if (req.user.role === 'school') {
        return res.status(403).json({ error: '无权删除学校' });
    }
    const schoolId = req.params.id;
    const school = readJSON('schools.json').find(s => s.id === schoolId);
    if (!school) return res.status(404).json({ error: '学校不存在' });

    const cascade = { canteens: 0, contracts: 0, selections: 0, users: 0 };

    // 1. 找出该学校的所有食堂ID
    let canteens = readJSON('canteens.json');
    const schoolCanteenIds = canteens.filter(c => c.schoolId === schoolId).map(c => c.id);
    canteens = canteens.filter(c => c.schoolId !== schoolId);
    cascade.canteens = schoolCanteenIds.length;
    writeJSON('canteens.json', canteens);

    // 2. 删除关联的合同（学校+食堂）
    let contracts = readJSON('contracts.json');
    const contractCount = contracts.length;
    contracts = contracts.filter(c => {
        if (c.relatedSchoolId === schoolId) return false;
        if (c.relatedCanteenId && schoolCanteenIds.includes(c.relatedCanteenId)) return false;
        return true;
    });
    cascade.contracts = contractCount - contracts.length;
    writeJSON('contracts.json', contracts);

    // 3. 删除遴选数据
    // 先找出该学校的所有公告ID
    let announcements = readJSON('selectionAnnouncements.json');
    const schoolAnnouncementIds = announcements.filter(a => a.schoolId === schoolId).map(a => a.id);
    announcements = announcements.filter(a => a.schoolId !== schoolId);
    cascade.selections += schoolAnnouncementIds.length;
    writeJSON('selectionAnnouncements.json', announcements);

    // 删除关联学校的遴选候选/入围/结果/合同（通过schoolId而非announcementId）
    const selByAnnouncement = ['selectionRegistrations','selectionInspections'];
    const selBySchool = ['selectionCandidates','selectionShortlisted','selectionResults','selectionContracts'];

    selByAnnouncement.forEach(f => {
        let data = readJSON(f + '.json');
        const before = data.length;
        data = data.filter(d => !schoolAnnouncementIds.includes(d.announcementId));
        cascade.selections += before - data.length;
        writeJSON(f + '.json', data);
    });

    selBySchool.forEach(f => {
        let data = readJSON(f + '.json');
        const before = data.length;
        data = data.filter(d => !schoolAnnouncementIds.includes(d.announcementId) && d.schoolId !== schoolId);
        cascade.selections += before - data.length;
        writeJSON(f + '.json', data);
    });

    // 4. 删除学校用户账号
    let users = readJSON('users.json');
    const userCount = users.length;
    users = users.filter(u => !(u.id === schoolId && u.role === 'school'));
    cascade.users = userCount - users.length;
    writeJSON('users.json', users);

    // 5. 删除学校本身
    let schools = readJSON('schools.json');
    schools = schools.filter(s => s.id !== schoolId);
    writeJSON('schools.json', schools);

    res.json({ message: '删除成功', cascade });
});

// --- Canteens ---
app.get('/api/canteens', authMiddleware, (req, res) => {
    let canteens = readJSON('canteens.json');
    // 按学年筛选
    const academicYear = req.query.academicYear;
    if (academicYear) {
        canteens = canteens.filter(c => c.academicYear === academicYear);
    }
    if (req.user.role === 'school' && req.user.schoolId) {
        canteens = canteens.filter(c => c.schoolId === req.user.schoolId);
    }
    sendListResponse(req, res, canteens, ['name', 'code', 'manager', 'phone', 'operationMode', 'status']);
});

app.get('/api/canteens/export', authMiddleware, (req, res) => {
    let canteens = readJSON('canteens.json');
    const schools = readJSON('schools.json');
    if (req.query.academicYear) canteens = canteens.filter(c => c.academicYear === req.query.academicYear);
    if (req.user.role === 'school' && req.user.schoolId) canteens = canteens.filter(c => c.schoolId === req.user.schoolId);
    const rows = applyListQuery(canteens, { ...req.query, page: 1, pageSize: Number.MAX_SAFE_INTEGER }, ['name', 'code', 'manager', 'phone', 'operationMode', 'status']).data
        .map(c => ({
            name: c.name || '',
            code: c.code || '',
            schoolName: schools.find(s => s.id === c.schoolId)?.name || c.schoolId || '',
            manager: c.manager || '',
            phone: c.phone || '',
            operationMode: c.operationMode || '',
            foodSafetyStaff: c.foodSafetyStaff || '',
            status: c.status || '',
            academicYear: c.academicYear || ''
        }));
    exportExcel(res, '食堂信息导出', '食堂信息', [
        { key: 'name', label: '食堂名称', width: 24 },
        { key: 'code', label: '食堂代码', width: 16 },
        { key: 'schoolName', label: '所属学校', width: 26 },
        { key: 'manager', label: '负责人', width: 12 },
        { key: 'phone', label: '联系电话', width: 16 },
        { key: 'operationMode', label: '经营模式', width: 14 },
        { key: 'foodSafetyStaff', label: '食品安全员', width: 14 },
        { key: 'status', label: '运营状态', width: 14 },
        { key: 'academicYear', label: '学年', width: 14 }
    ], rows);
});

app.get('/api/canteens/:id', authMiddleware, (req, res) => {
    const canteens = readJSON('canteens.json');
    const canteen = canteens.find(c => c.id === req.params.id);
    if (!canteen) return res.status(404).json({ error: '食堂不存在' });
    // 学校用户不能查看其他学校食堂
    if (req.user.role === 'school' && req.user.schoolId !== canteen.schoolId) {
        return res.status(403).json({ error: '无权查看此食堂' });
    }
    res.json(canteen);
});

app.post('/api/canteens', authMiddleware, (req, res) => {
    const canteens = readJSON('canteens.json');
    const schools = readJSON('schools.json');
    const config = readJSON('systemConfig.json');

    // 学校用户只能为本公司创建食堂
    if (req.user.role === 'school' && req.user.schoolId) {
        req.body.schoolId = req.user.schoolId;
    }

    const schoolId = req.body.schoolId;
    const school = schools.find(s => s.id === schoolId);

    // 校验食堂数量上限（仅当 canteenCount > 0 时限制，按学年统计）
    const canteenLimit = parseInt(school?.canteenCount) || 0;
    if (canteenLimit > 0) {
        const year = req.body.academicYear || config.currentAcademicYear;
        const currentCount = canteens.filter(c => c.schoolId === schoolId && c.academicYear === year).length;
        if (currentCount >= canteenLimit) {
            return res.status(400).json({ error: `该学校食堂数量已达上限（${canteenLimit}个），请先在学校信息中修改食堂数量` });
        }
    }

    const canteen = {
        id: 'canteen_' + Date.now(),
        ...req.body,
        academicYear: req.body.academicYear || config.currentAcademicYear,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    canteens.push(canteen);
    writeJSON('canteens.json', canteens);
    res.json(canteen);
});

app.put('/api/canteens/:id', authMiddleware, (req, res) => {
    const canteens = readJSON('canteens.json');
    const idx = canteens.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '食堂不存在' });
    // 学校用户只能修改本公司食堂
    if (req.user.role === 'school' && req.user.schoolId !== canteens[idx].schoolId) {
        return res.status(403).json({ error: '无权修改此食堂' });
    }

    const oldSchoolId = canteens[idx].schoolId;
    const newSchoolId = req.body.schoolId || oldSchoolId;
    canteens[idx] = { ...canteens[idx], ...req.body, updatedAt: new Date().toISOString() };
    writeJSON('canteens.json', canteens);
    res.json(canteens[idx]);
});

app.delete('/api/canteens/:id', authMiddleware, (req, res) => {
    // 学校用户不允许删除食堂
    if (req.user.role === 'school') {
        return res.status(403).json({ error: '无权删除食堂' });
    }
    let canteens = readJSON('canteens.json');
    const canteen = canteens.find(c => c.id === req.params.id);
    if (!canteen) return res.status(404).json({ error: '食堂不存在' });
    const schoolId = canteen.schoolId;
    const canteenId = req.params.id;
    canteens = canteens.filter(c => c.id !== canteenId);
    writeJSON('canteens.json', canteens);

    // 级联删除关联的合同和遴选引用
    let contracts = readJSON('contracts.json');
    const beforeContracts = contracts.length;
    contracts = contracts.filter(c => c.relatedCanteenId !== canteenId);
    writeJSON('contracts.json', contracts);

    // 清除遴选公告中对该食堂的引用（设为空）
    let announcements = readJSON('selectionAnnouncements.json');
    announcements.forEach(a => { if (a.canteenId === canteenId) a.canteenId = ''; });
    writeJSON('selectionAnnouncements.json', announcements);

    let selContracts = readJSON('selectionContracts.json');
    selContracts = selContracts.filter(s => s.canteenId !== canteenId);
    writeJSON('selectionContracts.json', selContracts);

    const cascade = { contracts: beforeContracts - contracts.length, selectionContracts: 0 };
    res.json({ message: '删除成功', cascade });
});

// 供应商级联删除辅助函数
function deleteSupplierCascade(supplierId) {
    const cascade = { contracts: 0, licenses: 0, credentials: 0, selections: 0, users: 0 };

    // 删除关联合同
    let contracts = readJSON('contracts.json');
    const beforeC = contracts.length;
    contracts = contracts.filter(c => c.ownerId !== supplierId);
    cascade.contracts = beforeC - contracts.length;
    writeJSON('contracts.json', contracts);

    // 删除企业证照
    let licenses = readJSON('enterpriseLicenses.json');
    const beforeL = licenses.length;
    licenses = licenses.filter(l => l.enterpriseId !== supplierId);
    cascade.licenses = beforeL - licenses.length;
    writeJSON('enterpriseLicenses.json', licenses);

    // 删除证照
    let credentials = readJSON('credentials.json');
    const beforeCr = credentials.length;
    credentials = credentials.filter(c => c.ownerId !== supplierId);
    cascade.credentials = beforeCr - credentials.length;
    writeJSON('credentials.json', credentials);

    // 删除遴选报名
    let registrations = readJSON('selectionRegistrations.json');
    const beforeR = registrations.length;
    registrations = registrations.filter(r => r.enterpriseId !== supplierId);
    cascade.selections += beforeR - registrations.length;
    writeJSON('selectionRegistrations.json', registrations);

    // 删除遴选考察
    let inspections = readJSON('selectionInspections.json');
    const beforeI = inspections.length;
    inspections = inspections.filter(i => i.enterpriseId !== supplierId);
    cascade.selections += beforeI - inspections.length;
    writeJSON('selectionInspections.json', inspections);

    // 从遴选候选/入围/结果/合同中移除该企业
    ['selectionCandidates.json','selectionShortlisted.json','selectionResults.json','selectionContracts.json'].forEach(f => {
        let data = readJSON(f);
        const before = data.length;

        // 处理数组类型字段
        if (f === 'selectionCandidates.json') {
            data = data.filter(d => {
                if (d.confirmedEnterprises && Array.isArray(d.confirmedEnterprises)) {
                    d.confirmedEnterprises = d.confirmedEnterprises.filter(e => e.enterpriseId !== supplierId);
                }
                return true; // 保留记录，只是移除企业引用
            });
        } else if (f === 'selectionShortlisted.json') {
            data = data.filter(d => {
                if (d.shortlistedEnterprises && Array.isArray(d.shortlistedEnterprises)) {
                    d.shortlistedEnterprises = d.shortlistedEnterprises.filter(e => e.enterpriseId !== supplierId);
                }
                return true;
            });
            writeJSON(f, data);
            return;
        } else if (f === 'selectionResults.json') {
            data.forEach(d => {
                if (d.winningEnterprise && d.winningEnterprise.enterpriseId === supplierId) {
                    d.winningEnterprise = null;
                }
            });
        } else {
            // selectionContracts - 直接删除
            data = data.filter(d => d.enterpriseId !== supplierId);
        }
        cascade.selections += before - data.length;
        writeJSON(f, data);
    });

    // 删除供应商用户账号（id与supplierId相同的用户）
    let users = readJSON('users.json');
    const beforeU = users.length;
    users = users.filter(u => !(u.id === supplierId && ['ingredientSupplier','cateringCompany','operationSupplier','serviceSupplier'].includes(u.role)));
    cascade.users = beforeU - users.length;
    writeJSON('users.json', users);

    // 清理食堂-供应商关联
    let links = readJSON('canteenSupplierLinks.json');
    const beforeLink = links.length;
    links = links.filter(l => l.supplierId !== supplierId);
    if (beforeLink !== links.length) writeJSON('canteenSupplierLinks.json', links);

    return cascade;
}

const ENTERPRISE_ROLE_TYPES = ['enterprise', 'ingredientSupplier', 'cateringCompany', 'operationSupplier', 'serviceSupplier'];

function isEnterpriseUser(user) {
    return user && ENTERPRISE_ROLE_TYPES.includes(user.role);
}

function findOwnedEnterpriseRecord(user, records) {
    if (!isEnterpriseUser(user)) return null;
    return records.find(r => r.userId === user.id)
        || records.find(r => r.id === user.id)
        || records.find(r => r.name && r.name === user.name)
        || null;
}

function filterEnterpriseRecordsForUser(records, user) {
    if (!isEnterpriseUser(user)) return records;
    const owned = findOwnedEnterpriseRecord(user, records);
    return owned ? [owned] : [];
}

function ensureEnterpriseRecordAccess(user, records, id) {
    const record = records.find(r => r.id === id);
    if (!record) return { errorStatus: 404, error: 'record not found' };
    if (isEnterpriseUser(user) && record !== findOwnedEnterpriseRecord(user, records)) {
        return { errorStatus: 403, error: 'forbidden' };
    }
    return { record };
}

function requireAdminForEnterpriseCreateDelete(req, res) {
    if (req.user.role !== 'admin') {
        res.status(403).json({ error: 'forbidden' });
        return false;
    }
    return true;
}

function getLicenseWarnLevel(validUntil, now = new Date()) {
    if (!validUntil) return 'green';
    const endDate = new Date(validUntil);
    if (Number.isNaN(endDate.getTime())) return 'green';
    const daysLeft = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));
    if (daysLeft <= 7) return 'red';
    if (daysLeft <= 30) return 'yellow';
    return 'green';
}

function getByPath(obj, key) {
    return String(obj?.[key] ?? '').toLowerCase();
}

function applyListQuery(items, query, searchFields = []) {
    let result = [...items];
    const search = String(query.search || '').trim().toLowerCase();
    if (search && searchFields.length) {
        result = result.filter(item => searchFields.some(field => getByPath(item, field).includes(search)));
    }

    const sortBy = query.sortBy;
    if (sortBy) {
        const sortOrder = String(query.sortOrder || 'asc').toLowerCase() === 'desc' ? -1 : 1;
        result.sort((a, b) => getByPath(a, sortBy).localeCompare(getByPath(b, sortBy), 'zh-CN', { numeric: true }) * sortOrder);
    }

    const total = result.length;
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const pageSize = Math.max(parseInt(query.pageSize, 10) || total || 1, 1);
    const start = (page - 1) * pageSize;
    return { data: result.slice(start, start + pageSize), total, page, pageSize };
}

function sendListResponse(req, res, items, searchFields = []) {
    const queried = applyListQuery(items, req.query, searchFields);
    if (req.query.page || req.query.pageSize || req.query.search || req.query.sortBy) {
        return res.json(queried);
    }
    res.json(queried.data);
}

function exportExcel(res, filenamePrefix, sheetName, headers, rows) {
    const XLSX = require('xlsx');
    const data = [headers.map(h => h.label), ...rows.map(row => headers.map(h => row[h.key] ?? ''))];
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = headers.map(h => ({ wch: h.width || 16 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `${filenamePrefix}_${new Date().toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
}

function exportSuppliers(req, res, filenamePrefix, sheetName, items) {
    const rows = applyListQuery(items, { ...req.query, page: 1, pageSize: Number.MAX_SAFE_INTEGER }, ['name', 'code', 'companyType', 'region', 'legalPerson', 'phone']).data;
    exportExcel(res, filenamePrefix, sheetName, [
        { key: 'name', label: '企业名称', width: 28 },
        { key: 'code', label: '统一社会信用代码', width: 22 },
        { key: 'companyType', label: '企业类型', width: 18 },
        { key: 'region', label: '所在区域', width: 18 },
        { key: 'address', label: '详细地址', width: 32 },
        { key: 'legalPerson', label: '法定代表人', width: 14 },
        { key: 'phone', label: '联系电话', width: 16 },
        { key: 'capital', label: '注册资本', width: 12 },
        { key: 'establishDate', label: '成立日期', width: 14 },
        { key: 'businessScope', label: '经营范围', width: 36 },
        { key: 'academicYear', label: '学年', width: 14 }
    ], rows);
}

function isCountableSignedContract(contract) {
    const status = String(contract.status || '');
    if (!status) return true;
    return !status.includes('草稿') && !status.includes('终止') && !status.includes('解除');
}

function getSchoolStudentCount(school) {
    return Number(school?.studentCount || school?.学生人数 || 0) || 0;
}

function withComputedCateringCurrentSupply(companies) {
    const schools = readJSON('schools.json');
    const contracts = readJSON('contracts.json');
    const selectionContracts = readJSON('selectionContracts.json');
    const companyIds = new Set(companies.map(c => c.id));
    const companyNames = new Map(companies.map(c => [c.name, c.id]));
    const schoolsById = new Map(schools.map(s => [s.id, s]));
    const schoolsByName = new Map(schools.map(s => [s.name, s]));
    const totals = new Map(companies.map(c => [c.id, 0]));
    const countedSchoolKeys = new Set();
    const linkedSelectionContractIds = new Set(contracts.map(c => c.selectionContractId).filter(Boolean));

    const addContract = ({ enterpriseId, enterpriseName, schoolId, schoolName, status, selectionContractId }) => {
        if (!isCountableSignedContract({ status })) return;
        const companyId = companyIds.has(enterpriseId) ? enterpriseId : companyNames.get(enterpriseName);
        if (!companyId) return;
        const school = schoolsById.get(schoolId) || schoolsByName.get(schoolName);
        if (!school) return;
        const schoolKey = school.id || schoolId || schoolName || selectionContractId;
        const countKey = `${companyId}|${schoolKey}`;
        if (countedSchoolKeys.has(countKey)) return;
        countedSchoolKeys.add(countKey);
        totals.set(companyId, (totals.get(companyId) || 0) + getSchoolStudentCount(school));
    };

    contracts.forEach(contract => addContract({
        enterpriseId: contract.ownerId,
        enterpriseName: contract.ownerName,
        schoolId: contract.relatedSchoolId || contract.schoolId,
        schoolName: contract.relatedSchoolName,
        status: contract.status,
        selectionContractId: contract.selectionContractId
    }));

    selectionContracts
        .filter(contract => !linkedSelectionContractIds.has(contract.id))
        .forEach(contract => addContract({
            enterpriseId: contract.enterpriseId,
            enterpriseName: contract.enterpriseName,
            schoolId: contract.schoolId,
            schoolName: contract.schoolName,
            status: contract.status,
            selectionContractId: contract.id
        }));

    return companies.map(company => ({
        ...company,
        currentSupply: totals.get(company.id) || 0
    }));
}

const supplierFieldAliases = {
    name: ['name', '企业名称', '供应商名称'],
    code: ['code', '统一社会信用代码', '信用代码'],
    companyType: ['companyType', '企业类型'],
    region: ['region', '所在区域', '区域'],
    address: ['address', '详细地址', '地址'],
    legalPerson: ['legalPerson', '法定代表人', '法人'],
    phone: ['phone', '联系电话', '电话'],
    capital: ['capital', '注册资本', '注册资本（万元）'],
    establishDate: ['establishDate', '成立日期'],
    businessScope: ['businessScope', '经营范围'],
    academicYear: ['academicYear', '学年'],
    mainProducts: ['mainProducts', '主营产品类别', '主营产品'],
    dailyCapacity: ['dailyCapacity', '日均供餐能力', '日均供餐能力（份）'],
    currentSupply: ['currentSupply', '现日供餐数量'],
    emergencyBackup: ['emergencyBackup', '应急备选企业'],
    operatedCanteens: ['operatedCanteens', '食堂委托经营项目数'],
    serviceScope: ['serviceScope', '服务范围']
};

function pickImportValue(item, key, fallback = '') {
    const aliases = supplierFieldAliases[key] || [key];
    for (const alias of aliases) {
        if (item[alias] !== undefined && item[alias] !== null && item[alias] !== '') {
            return item[alias];
        }
    }
    return fallback;
}

function normalizeSupplierImportItem(item, type, config, now) {
    const supplier = {
        name: String(pickImportValue(item, 'name')).trim(),
        code: String(pickImportValue(item, 'code')).trim(),
        companyType: String(pickImportValue(item, 'companyType', '有限责任公司')).trim(),
        region: String(pickImportValue(item, 'region')).trim(),
        address: String(pickImportValue(item, 'address')).trim(),
        legalPerson: String(pickImportValue(item, 'legalPerson')).trim(),
        phone: String(pickImportValue(item, 'phone')).trim(),
        capital: String(pickImportValue(item, 'capital')).trim(),
        establishDate: String(pickImportValue(item, 'establishDate')).trim(),
        businessScope: String(pickImportValue(item, 'businessScope')).trim(),
        academicYear: String(pickImportValue(item, 'academicYear', config.currentAcademicYear || '')).trim(),
        createdAt: now,
        updatedAt: now
    };

    if (type === 'ingredient') {
        supplier.mainProducts = String(pickImportValue(item, 'mainProducts')).trim();
    } else if (type === 'catering') {
        supplier.dailyCapacity = String(pickImportValue(item, 'dailyCapacity')).trim();
        supplier.currentSupply = 0;
        supplier.emergencyBackup = String(pickImportValue(item, 'emergencyBackup')).trim();
    } else if (type === 'operation') {
        supplier.operatedCanteens = String(pickImportValue(item, 'operatedCanteens')).trim();
    } else if (type === 'service') {
        supplier.serviceScope = String(pickImportValue(item, 'serviceScope')).trim();
    }

    return supplier;
}

function processSupplierBatchImport(items, type, dataFile, idPrefix) {
    const existing = readJSON(dataFile);
    const config = readJSON('systemConfig.json');
    const results = { success: 0, failed: 0, errors: [], imported: [] };
    const existingCodes = new Set(existing.map(s => String(s.code || '').trim()).filter(Boolean));
    const batchCodes = new Set();
    const now = new Date().toISOString();

    items.forEach((item, index) => {
        const supplier = normalizeSupplierImportItem(item, type, config, now);
        const rowNo = index + 1;
        if (!supplier.name) {
            results.failed++;
            results.errors.push(`row ${rowNo}: supplier name is required`);
            return;
        }
        if (!supplier.code) {
            results.failed++;
            results.errors.push(`row ${rowNo}: unified social credit code is required`);
            return;
        }
        if (existingCodes.has(supplier.code) || batchCodes.has(supplier.code)) {
            results.failed++;
            results.errors.push(`row ${rowNo}: supplier code "${supplier.code}" already exists`);
            return;
        }
        batchCodes.add(supplier.code);
        supplier.id = `${idPrefix}${Date.now()}_${index}`;
        existing.push(supplier);
        results.imported.push(supplier);
        results.success++;
    });

    if (results.success > 0) {
        writeJSON(dataFile, existing);
    }
    return results;
}

function handleSupplierBatchImport(req, res, type, dataFile, idPrefix) {
    if (!requireAdminForEnterpriseCreateDelete(req, res)) return;
    const items = req.body?.suppliers;
    if (!Array.isArray(items)) {
        return res.status(400).json({ error: 'suppliers must be an array' });
    }
    res.json(processSupplierBatchImport(items, type, dataFile, idPrefix));
}

function handleSupplierBatchImportFile(req, res, type, dataFile, idPrefix) {
    if (!requireAdminForEnterpriseCreateDelete(req, res)) return;
    if (!req.file) {
        return res.status(400).json({ error: 'Excel file is required' });
    }
    const XLSX = require('xlsx');
    let workbook;
    try {
        workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    } catch (e) {
        return res.status(400).json({ error: 'Unable to parse Excel file' });
    }
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const items = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!items.length) {
        return res.status(400).json({ error: 'Excel file has no data rows' });
    }
    res.json(processSupplierBatchImport(items, type, dataFile, idPrefix));
}

const ENTERPRISE_LICENSE_SOURCES = [
    { role: 'ingredientSupplier', file: 'ingredientSuppliers.json', type: '食材供应商' },
    { role: 'cateringCompany', file: 'cateringCompanies.json', type: '校外供餐企业' },
    { role: 'operationSupplier', file: 'operationSuppliers.json', type: '委托经营供应商' },
    { role: 'serviceSupplier', file: 'serviceSuppliers.json', type: '委托服务提供商' }
];

function withCurrentEnterpriseLicenses(records) {
    return attachCurrentLicensesToEnterprises(records, readJSON('enterpriseLicenses.json'));
}

function findEnterpriseRecordForLicense(user, requestedEnterpriseId) {
    if (user.role === 'admin') {
        if (!requestedEnterpriseId) return null;
        for (const source of ENTERPRISE_LICENSE_SOURCES) {
            const record = readJSON(source.file).find(item => item.id === requestedEnterpriseId);
            if (record) return { ...record, enterpriseType: source.type, file: source.file };
        }
        return null;
    }

    const source = ENTERPRISE_LICENSE_SOURCES.find(item => item.role === user.role);
    if (!source) return null;
    const record = readJSON(source.file).find(item => item.userId === user.id) ||
        readJSON(source.file).find(item => item.name === user.name);
    if (!record) return null;
    return { ...record, enterpriseType: source.type, file: source.file };
}

function syncEnterpriseRecordWithLicense(license) {
    if (!license || (license.status || LICENSE_STATUSES.CURRENT) !== LICENSE_STATUSES.CURRENT) return;
    for (const source of ENTERPRISE_LICENSE_SOURCES) {
        const records = readJSON(source.file);
        const idx = records.findIndex(item => item.id === license.enterpriseId);
        if (idx === -1) continue;
        records[idx] = {
            ...applyLicenseToEnterpriseRecord(records[idx], license),
            updatedAt: new Date().toISOString()
        };
        writeJSON(source.file, records);
        return;
    }
}

// --- Ingredient Suppliers ---
app.get('/api/ingredient-suppliers', authMiddleware, (req, res) => {
    let suppliers = readJSON('ingredientSuppliers.json');
    const academicYear = req.query.academicYear;
    if (academicYear) {
        suppliers = suppliers.filter(s => s.academicYear && s.academicYear === academicYear);
    }
    suppliers = filterEnterpriseRecordsForUser(suppliers, req.user);
    suppliers = withCurrentEnterpriseLicenses(suppliers);
    sendListResponse(req, res, suppliers, ['name', 'code', 'companyType', 'region', 'legalPerson', 'phone']);
});

app.get('/api/ingredient-suppliers/export', authMiddleware, (req, res) => {
    let suppliers = readJSON('ingredientSuppliers.json');
    if (req.query.academicYear) suppliers = suppliers.filter(s => s.academicYear && s.academicYear === req.query.academicYear);
    suppliers = filterEnterpriseRecordsForUser(suppliers, req.user);
    exportSuppliers(req, res, '食材供应商导出', '食材供应商', suppliers);
});

app.post('/api/ingredient-suppliers/batch-import', authMiddleware, roleMiddleware('admin'), (req, res) => {
    handleSupplierBatchImport(req, res, 'ingredient', 'ingredientSuppliers.json', 'ing_');
});

app.post('/api/ingredient-suppliers/batch-import-file', upload.single('file'), authMiddleware, roleMiddleware('admin'), (req, res) => {
    handleSupplierBatchImportFile(req, res, 'ingredient', 'ingredientSuppliers.json', 'ing_');
});

app.get('/api/ingredient-suppliers/:id', authMiddleware, (req, res) => {
    const suppliers = readJSON('ingredientSuppliers.json');
    const supplier = withCurrentEnterpriseLicenses(suppliers).find(s => s.id === req.params.id);
    const access = ensureEnterpriseRecordAccess(req.user, suppliers, req.params.id);
    if (access.errorStatus) return res.status(access.errorStatus).json({ error: access.error });
    if (!supplier) return res.status(404).json({ error: '供应商不存在' });
    res.json(supplier);
});

app.post('/api/ingredient-suppliers', authMiddleware, (req, res) => {
    if (!requireAdminForEnterpriseCreateDelete(req, res)) return;
    const suppliers = readJSON('ingredientSuppliers.json');
    const config = readJSON('systemConfig.json');
    const supplier = {
        id: 'ing_' + Date.now(),
        ...req.body,
        academicYear: req.body.academicYear || config.currentAcademicYear || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    suppliers.push(supplier);
    writeJSON('ingredientSuppliers.json', suppliers);
    res.json(supplier);
});

app.put('/api/ingredient-suppliers/:id', authMiddleware, (req, res) => {
    const suppliers = readJSON('ingredientSuppliers.json');
    const idx = suppliers.findIndex(s => s.id === req.params.id);
    const access = ensureEnterpriseRecordAccess(req.user, suppliers, req.params.id);
    if (access.errorStatus) return res.status(access.errorStatus).json({ error: access.error });
    if (idx === -1) return res.status(404).json({ error: '供应商不存在' });
    suppliers[idx] = { ...suppliers[idx], ...req.body, updatedAt: new Date().toISOString() };
    writeJSON('ingredientSuppliers.json', suppliers);
    res.json(suppliers[idx]);
});

app.delete('/api/ingredient-suppliers/:id', authMiddleware, (req, res) => {
    if (!requireAdminForEnterpriseCreateDelete(req, res)) return;
    const supplierId = req.params.id;
    let suppliers = readJSON('ingredientSuppliers.json');
    if (!suppliers.find(s => s.id === supplierId)) return res.status(404).json({ error: '供应商不存在' });
    suppliers = suppliers.filter(s => s.id !== supplierId);
    writeJSON('ingredientSuppliers.json', suppliers);
    const cascade = deleteSupplierCascade(supplierId);
    res.json({ message: '删除成功', cascade });
});

// --- Catering Companies ---
app.get('/api/catering-companies', authMiddleware, (req, res) => {
    let companies = readJSON('cateringCompanies.json');
    const academicYear = req.query.academicYear;
    if (academicYear) {
        companies = companies.filter(c => c.academicYear && c.academicYear === academicYear);
    }
    companies = filterEnterpriseRecordsForUser(companies, req.user);
    companies = withComputedCateringCurrentSupply(companies);
    companies = withCurrentEnterpriseLicenses(companies);
    sendListResponse(req, res, companies, ['name', 'code', 'companyType', 'region', 'legalPerson', 'phone']);
});

app.get('/api/catering-companies/export', authMiddleware, (req, res) => {
    let companies = readJSON('cateringCompanies.json');
    if (req.query.academicYear) companies = companies.filter(c => c.academicYear && c.academicYear === req.query.academicYear);
    companies = filterEnterpriseRecordsForUser(companies, req.user);
    companies = withComputedCateringCurrentSupply(companies);
    exportSuppliers(req, res, '校外供餐企业导出', '校外供餐企业', companies);
});

app.post('/api/catering-companies/batch-import', authMiddleware, roleMiddleware('admin'), (req, res) => {
    handleSupplierBatchImport(req, res, 'catering', 'cateringCompanies.json', 'catering_');
});

app.post('/api/catering-companies/batch-import-file', upload.single('file'), authMiddleware, roleMiddleware('admin'), (req, res) => {
    handleSupplierBatchImportFile(req, res, 'catering', 'cateringCompanies.json', 'catering_');
});

app.get('/api/catering-companies/:id', authMiddleware, (req, res) => {
    const companies = readJSON('cateringCompanies.json');
    const computedCompanies = withCurrentEnterpriseLicenses(withComputedCateringCurrentSupply(companies));
    const company = computedCompanies.find(c => c.id === req.params.id);
    const access = ensureEnterpriseRecordAccess(req.user, companies, req.params.id);
    if (access.errorStatus) return res.status(access.errorStatus).json({ error: access.error });
    if (!company) return res.status(404).json({ error: '企业不存在' });
    res.json(company);
});

app.post('/api/catering-companies', authMiddleware, (req, res) => {
    if (!requireAdminForEnterpriseCreateDelete(req, res)) return;
    const companies = readJSON('cateringCompanies.json');
    const config = readJSON('systemConfig.json');
    const company = {
        id: 'catering_' + Date.now(),
        ...req.body,
        academicYear: req.body.academicYear || config.currentAcademicYear || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    companies.push(company);
    writeJSON('cateringCompanies.json', companies);
    res.json(company);
});

app.put('/api/catering-companies/:id', authMiddleware, (req, res) => {
    const companies = readJSON('cateringCompanies.json');
    const idx = companies.findIndex(c => c.id === req.params.id);
    const access = ensureEnterpriseRecordAccess(req.user, companies, req.params.id);
    if (access.errorStatus) return res.status(access.errorStatus).json({ error: access.error });
    if (idx === -1) return res.status(404).json({ error: '企业不存在' });
    companies[idx] = { ...companies[idx], ...req.body, updatedAt: new Date().toISOString() };
    writeJSON('cateringCompanies.json', companies);
    res.json(companies[idx]);
});

app.delete('/api/catering-companies/:id', authMiddleware, (req, res) => {
    if (!requireAdminForEnterpriseCreateDelete(req, res)) return;
    const supplierId = req.params.id;
    let companies = readJSON('cateringCompanies.json');
    if (!companies.find(c => c.id === supplierId)) return res.status(404).json({ error: '企业不存在' });
    companies = companies.filter(c => c.id !== supplierId);
    writeJSON('cateringCompanies.json', companies);
    const cascade = deleteSupplierCascade(supplierId);
    res.json({ message: '删除成功', cascade });
});

// --- Operation Suppliers ---
app.get('/api/operation-suppliers', authMiddleware, (req, res) => {
    let suppliers = readJSON('operationSuppliers.json');
    const academicYear = req.query.academicYear;
    if (academicYear) {
        suppliers = suppliers.filter(s => s.academicYear && s.academicYear === academicYear);
    }
    suppliers = filterEnterpriseRecordsForUser(suppliers, req.user);
    suppliers = withCurrentEnterpriseLicenses(suppliers);
    sendListResponse(req, res, suppliers, ['name', 'code', 'companyType', 'region', 'legalPerson', 'phone']);
});

app.get('/api/operation-suppliers/export', authMiddleware, (req, res) => {
    let suppliers = readJSON('operationSuppliers.json');
    if (req.query.academicYear) suppliers = suppliers.filter(s => s.academicYear && s.academicYear === req.query.academicYear);
    suppliers = filterEnterpriseRecordsForUser(suppliers, req.user);
    exportSuppliers(req, res, '委托经营供应商导出', '委托经营供应商', suppliers);
});

app.post('/api/operation-suppliers/batch-import', authMiddleware, roleMiddleware('admin'), (req, res) => {
    handleSupplierBatchImport(req, res, 'operation', 'operationSuppliers.json', 'op_');
});

app.post('/api/operation-suppliers/batch-import-file', upload.single('file'), authMiddleware, roleMiddleware('admin'), (req, res) => {
    handleSupplierBatchImportFile(req, res, 'operation', 'operationSuppliers.json', 'op_');
});

app.get('/api/operation-suppliers/:id', authMiddleware, (req, res) => {
    const suppliers = readJSON('operationSuppliers.json');
    const access = ensureEnterpriseRecordAccess(req.user, suppliers, req.params.id);
    if (access.errorStatus) return res.status(access.errorStatus).json({ error: access.error });
    res.json(withCurrentEnterpriseLicenses([access.record])[0]);
});

app.post('/api/operation-suppliers', authMiddleware, (req, res) => {
    if (!requireAdminForEnterpriseCreateDelete(req, res)) return;
    const suppliers = readJSON('operationSuppliers.json');
    const config = readJSON('systemConfig.json');
    const supplier = {
        id: 'op_' + Date.now(),
        ...req.body,
        academicYear: req.body.academicYear || config.currentAcademicYear || '',
        createdAt: new Date().toISOString()
    };
    suppliers.push(supplier);
    writeJSON('operationSuppliers.json', suppliers);
    res.json(supplier);
});

app.put('/api/operation-suppliers/:id', authMiddleware, (req, res) => {
    const suppliers = readJSON('operationSuppliers.json');
    const idx = suppliers.findIndex(s => s.id === req.params.id);
    const access = ensureEnterpriseRecordAccess(req.user, suppliers, req.params.id);
    if (access.errorStatus) return res.status(access.errorStatus).json({ error: access.error });
    if (idx === -1) return res.status(404).json({ error: '供应商不存在' });
    suppliers[idx] = { ...suppliers[idx], ...req.body };
    writeJSON('operationSuppliers.json', suppliers);
    res.json(suppliers[idx]);
});

app.delete('/api/operation-suppliers/:id', authMiddleware, (req, res) => {
    if (!requireAdminForEnterpriseCreateDelete(req, res)) return;
    const supplierId = req.params.id;
    let suppliers = readJSON('operationSuppliers.json');
    if (!suppliers.find(s => s.id === supplierId)) return res.status(404).json({ error: '供应商不存在' });
    suppliers = suppliers.filter(s => s.id !== supplierId);
    writeJSON('operationSuppliers.json', suppliers);
    const cascade = deleteSupplierCascade(supplierId);
    res.json({ message: '删除成功', cascade });
});

// --- Service Suppliers ---
app.get('/api/service-suppliers', authMiddleware, (req, res) => {
    let suppliers = readJSON('serviceSuppliers.json');
    const academicYear = req.query.academicYear;
    if (academicYear) {
        suppliers = suppliers.filter(s => s.academicYear && s.academicYear === academicYear);
    }
    suppliers = filterEnterpriseRecordsForUser(suppliers, req.user);
    suppliers = withCurrentEnterpriseLicenses(suppliers);
    sendListResponse(req, res, suppliers, ['name', 'code', 'companyType', 'region', 'legalPerson', 'phone']);
});

app.get('/api/service-suppliers/export', authMiddleware, (req, res) => {
    let suppliers = readJSON('serviceSuppliers.json');
    if (req.query.academicYear) suppliers = suppliers.filter(s => s.academicYear && s.academicYear === req.query.academicYear);
    suppliers = filterEnterpriseRecordsForUser(suppliers, req.user);
    exportSuppliers(req, res, '委托服务提供商导出', '委托服务提供商', suppliers);
});

app.post('/api/service-suppliers/batch-import', authMiddleware, roleMiddleware('admin'), (req, res) => {
    handleSupplierBatchImport(req, res, 'service', 'serviceSuppliers.json', 'svc_');
});

app.post('/api/service-suppliers/batch-import-file', upload.single('file'), authMiddleware, roleMiddleware('admin'), (req, res) => {
    handleSupplierBatchImportFile(req, res, 'service', 'serviceSuppliers.json', 'svc_');
});

app.get('/api/service-suppliers/:id', authMiddleware, (req, res) => {
    const suppliers = readJSON('serviceSuppliers.json');
    const access = ensureEnterpriseRecordAccess(req.user, suppliers, req.params.id);
    if (access.errorStatus) return res.status(access.errorStatus).json({ error: access.error });
    res.json(withCurrentEnterpriseLicenses([access.record])[0]);
});

app.post('/api/service-suppliers', authMiddleware, (req, res) => {
    if (!requireAdminForEnterpriseCreateDelete(req, res)) return;
    const suppliers = readJSON('serviceSuppliers.json');
    const config = readJSON('systemConfig.json');
    const supplier = {
        id: 'svc_' + Date.now(),
        ...req.body,
        academicYear: req.body.academicYear || config.currentAcademicYear || '',
        createdAt: new Date().toISOString()
    };
    suppliers.push(supplier);
    writeJSON('serviceSuppliers.json', suppliers);
    res.json(supplier);
});

app.put('/api/service-suppliers/:id', authMiddleware, (req, res) => {
    const suppliers = readJSON('serviceSuppliers.json');
    const idx = suppliers.findIndex(s => s.id === req.params.id);
    const access = ensureEnterpriseRecordAccess(req.user, suppliers, req.params.id);
    if (access.errorStatus) return res.status(access.errorStatus).json({ error: access.error });
    if (idx === -1) return res.status(404).json({ error: 'record not found' });
    suppliers[idx] = { ...suppliers[idx], ...req.body, updatedAt: new Date().toISOString() };
    writeJSON('serviceSuppliers.json', suppliers);
    res.json(suppliers[idx]);
});

app.delete('/api/service-suppliers/:id', authMiddleware, (req, res) => {
    if (!requireAdminForEnterpriseCreateDelete(req, res)) return;
    const supplierId = req.params.id;
    let suppliers = readJSON('serviceSuppliers.json');
    if (!suppliers.find(s => s.id === supplierId)) return res.status(404).json({ error: '供应商不存在' });
    suppliers = suppliers.filter(s => s.id !== supplierId);
    writeJSON('serviceSuppliers.json', suppliers);
    const cascade = deleteSupplierCascade(supplierId);
    res.json({ message: '删除成功', cascade });
});

// --- Credentials (统一证照管理 - 支持查看所有证照) ---
app.get('/api/credentials', authMiddleware, (req, res) => {
    // 合并 enterpriseLicenses 和 credentials 的数据
    const enterpriseLicenses = readJSON('enterpriseLicenses.json');
    let credentials = readJSON('credentials.json');

    credentials = buildCredentialRows(enterpriseLicenses, credentials);

    if (req.query.ownerId) {
        credentials = credentials.filter(c => c.ownerId === req.query.ownerId);
    }
    if (req.query.ownerType) {
        credentials = credentials.filter(c => c.ownerType === req.query.ownerType);
    }
    sendListResponse(req, res, credentials, ['name', 'ownerName', 'ownerType', 'type', 'licenseNo']);
});

// 学校用户查看合同关联企业的证照
app.get('/api/credentials/export', authMiddleware, (req, res) => {
    const enterpriseLicenses = readJSON('enterpriseLicenses.json');
    let credentials = readJSON('credentials.json');
    credentials = buildCredentialRows(enterpriseLicenses, credentials);
    if (req.query.ownerId) credentials = credentials.filter(c => c.ownerId === req.query.ownerId);
    if (req.query.ownerType) credentials = credentials.filter(c => c.ownerType === req.query.ownerType);
    const rows = applyListQuery(credentials, { ...req.query, page: 1, pageSize: Number.MAX_SAFE_INTEGER }, ['name', 'ownerName', 'ownerType', 'type', 'licenseNo']).data
        .map(c => ({ ...c, warnLevel: getLicenseWarnLevel(c.validUntil) }));
    exportExcel(res, '证照信息导出', '证照信息', [
        { key: 'name', label: '证照名称', width: 24 },
        { key: 'ownerName', label: '所属主体', width: 28 },
        { key: 'ownerType', label: '主体类型', width: 18 },
        { key: 'type', label: '证照类型', width: 18 },
        { key: 'licenseNo', label: '证照编号', width: 24 },
        { key: 'validFrom', label: '有效期起', width: 14 },
        { key: 'validUntil', label: '有效期止', width: 14 },
        { key: 'warnLevel', label: '预警状态', width: 12 }
    ], rows);
});

app.get('/api/school/enterprise-licenses', authMiddleware, (req, res) => {
    const user = req.user;

    // 只有学校用户才能访问
    if (user.role !== 'school') {
        return res.status(403).json({ error: '只有学校用户才能访问此接口' });
    }

    const schoolId = user.schoolId || user.id;
    const now = new Date();

    // 1. 获取该校的有效合同
    const contracts = readJSON('contracts.json');
    const validContracts = contracts.filter(c => {
        if (![c.relatedSchoolId, c.schoolId].includes(schoolId) && c.relatedSchoolId !== user.id) return false;
        const startDate = new Date(c.startDate);
        const endDate = new Date(c.endDate);
        return now >= startDate && now <= endDate;
    });

    console.log('学校', schoolId, '的有效合同:', validContracts.length);

    // 2. 获取合同关联企业的名称列表（按名称匹配，因为ID不统一）
    const enterpriseNames = [...new Set(validContracts.map(c => c.ownerName))];

    // 3. 获取这些企业的证照（按名称匹配）
    const allLicenses = readJSON('enterpriseLicenses.json');
    const enterpriseLicenses = currentEnterpriseLicenses(allLicenses)
        .filter(l => enterpriseNames.includes(l.enterpriseName || l.name));

    console.log('匹配到', enterpriseLicenses.length, '条证照');

    // 4. 转换为credentials格式并附加合同信息
    const result = enterpriseLicenses.map(el => {
        const contract = validContracts.find(c => c.ownerName === (el.enterpriseName || el.name));
        return {
            id: el.id,
            name: el.name,
            ownerId: el.enterpriseId,
            ownerName: el.enterpriseName || el.name,
            ownerType: el.enterpriseType || '企业',
            type: el.type,
            licenseNo: el.licenseNo,
            validFrom: el.validFrom,
            validUntil: el.validUntil,
            businessScope: el.businessScope,
            imageUrl: el.imageUrl,
            createdAt: el.createdAt,
            updatedAt: el.updatedAt,
            // 附加合同信息
            contractId: contract?.id || '',
            contractName: contract?.contractName || '',
            contractNo: contract?.contractNo || '',
            contractType: contract?.contractType || '',
            contractEndDate: contract?.endDate || '',
            _source: 'enterpriseLicense'
        };
    });

    res.json(result);
});

app.post('/api/credentials', authMiddleware, (req, res) => {
    const credentials = readJSON('credentials.json');
    const cred = {
        id: 'cred_' + Date.now(),
        ...req.body,
        createdAt: new Date().toISOString()
    };
    credentials.push(cred);
    writeJSON('credentials.json', credentials);
    res.json(cred);
});

app.put('/api/credentials/:id', authMiddleware, (req, res) => {
    const credentials = readJSON('credentials.json');
    const idx = credentials.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '证照不存在' });
    credentials[idx] = { ...credentials[idx], ...req.body };
    writeJSON('credentials.json', credentials);
    res.json(credentials[idx]);
});

app.delete('/api/credentials/:id', authMiddleware, (req, res) => {
    let credentials = readJSON('credentials.json');
    credentials = credentials.filter(c => c.id !== req.params.id);
    writeJSON('credentials.json', credentials);
    res.json({ message: '删除成功' });
});

// --- Red/Yellow Flag Warning ---
app.get('/api/warnings/stats', authMiddleware, (req, res) => {
    const user = req.user;
    const credentials = readJSON('credentials.json');
    const enterpriseLicenses = readJSON('enterpriseLicenses.json');
    const schools = readJSON('schools.json');
    const canteens = readJSON('canteens.json');
    const ingredientSuppliers = readJSON('ingredientSuppliers.json');
    const cateringCompanies = readJSON('cateringCompanies.json');
    const operationSuppliers = readJSON('operationSuppliers.json');
    const serviceSuppliers = readJSON('serviceSuppliers.json');
    const contracts = readJSON('contracts.json');

    const now = new Date();

    let yellowCount = 0;
    let redCount = 0;
    let greenCount = 0;
    let expiredList = [];
    let expiringList = [];

    // 合并 credentials 和 enterpriseLicenses
    const allLicenses = [
        ...credentials,
        ...enterpriseLicenses.map(el => ({
            ...el,
            ownerId: el.enterpriseId,
            ownerName: el.enterpriseName || el.name,
            ownerType: el.enterpriseType || '企业'
        }))
    ];

    // 如果是学校用户，只显示有有效合同的供应商证照
    let validEnterpriseNames = [];
    if (user.role === 'school') {
        const validContracts = contracts.filter(c => {
            if (c.relatedSchoolId !== user.id) return false;
            const startDate = new Date(c.startDate);
            const endDate = new Date(c.endDate);
            return now >= startDate && now <= endDate;
        });
        validEnterpriseNames = [...new Set(validContracts.map(c => c.ownerName))];
    }

    allLicenses.forEach(cred => {
        // 如果是学校用户，过滤只显示合同关联企业的证照
        if (user.role === 'school' && !validEnterpriseNames.includes(cred.name)) return;

        const warnLevel = getLicenseWarnLevel(cred.validUntil, now);
        if (warnLevel === 'red') {
            redCount++;
            expiredList.push(cred);
        } else if (warnLevel === 'yellow') {
            yellowCount++;
            expiringList.push(cred);
        } else {
            greenCount++;
        }
    });

    res.json({
        greenCount,
        yellowCount,
        redCount,
        expiredList,
        expiringList,
        totalSchools: schools.length,
        totalCanteens: canteens.length,
        totalIngredientSuppliers: ingredientSuppliers.length,
        totalCateringCompanies: cateringCompanies.length,
        totalOperationSuppliers: operationSuppliers.length,
        totalServiceSuppliers: serviceSuppliers.length
    });
});

// --- Dashboard Stats ---
app.get('/api/dashboard/stats', authMiddleware, (req, res) => {
    const academicYear = req.query.academicYear;
    let schools = readJSON('schools.json');
    let canteens = readJSON('canteens.json');
    let ingredientSuppliers = readJSON('ingredientSuppliers.json');
    let cateringCompanies = readJSON('cateringCompanies.json');
    let operationSuppliers = readJSON('operationSuppliers.json');
    let serviceSuppliers = readJSON('serviceSuppliers.json');
    const credentials = readJSON('credentials.json');
    const enterpriseLicenses = readJSON('enterpriseLicenses.json');

    if (academicYear) {
        schools = schools.filter(s => s.academicYear && s.academicYear === academicYear);
        canteens = canteens.filter(c => c.academicYear && c.academicYear === academicYear);
        ingredientSuppliers = ingredientSuppliers.filter(s => s.academicYear && s.academicYear === academicYear);
        cateringCompanies = cateringCompanies.filter(c => c.academicYear && c.academicYear === academicYear);
        operationSuppliers = operationSuppliers.filter(s => s.academicYear && s.academicYear === academicYear);
        serviceSuppliers = serviceSuppliers.filter(s => s.academicYear && s.academicYear === academicYear);
    }

    const now = new Date();
    let yellowCount = 0;
    let redCount = 0;
    let greenCount = 0;

    [...credentials, ...enterpriseLicenses].forEach(cred => {
        const warnLevel = getLicenseWarnLevel(cred.validUntil, now);
        if (warnLevel === 'red') redCount++;
        else if (warnLevel === 'yellow') yellowCount++;
        else greenCount++;
    });

    // 供餐类型统计
    let 校内Count = 0, 校外Count = 0, 无供餐Count = 0;
    schools.forEach(s => {
        const types = s.供餐类型 || [];
        if (types.includes('无供餐')) 无供餐Count++;
        else {
            if (types.includes('校内供餐')) 校内Count++;
            if (types.includes('校外供餐')) 校外Count++;
        }
    });

    res.json({
        totalSchools: schools.length,
        校内供餐Count: 校内Count,
        校外供餐Count: 校外Count,
        无供餐Count: 无供餐Count,
        totalCanteens: canteens.length,
        totalIngredientSuppliers: ingredientSuppliers.length,
        totalCateringCompanies: cateringCompanies.length,
        totalOperationSuppliers: operationSuppliers.length,
        totalServiceSuppliers: serviceSuppliers.length,
        greenWarningCount: greenCount,
        yellowWarningCount: yellowCount,
        redWarningCount: redCount
    });
});

// --- Contracts CRUD ---
app.get('/api/contracts', authMiddleware, (req, res) => {
    let contracts = readJSON('contracts.json');
    const user = req.user;

    if (user.role === 'school') {
        const schoolKey = user.schoolId || user.id;
        contracts = contracts.filter(c => c.relatedSchoolId === schoolKey || c.schoolId === schoolKey);
    } else if (['ingredientSupplier', 'cateringCompany', 'operationSupplier'].includes(user.role)) {
        // 企业用户按名称匹配（因为ownerId是企业ID，与user.id不匹配）
        contracts = contracts.filter(c => c.ownerName === user.name);
    }

    res.json(contracts);
});

app.post('/api/contracts', authMiddleware, (req, res) => {
    const contracts = readJSON('contracts.json');
    const {
        relatedSchoolId, relatedSchoolName, relatedCanteenId, relatedCanteenName,
        ownerId, ownerName, ownerType,
        contractNo, contractName, contractType,
        signDate, startDate, endDate, amount, paymentTerms, status, mealStandard, dinerCount, remarks
    } = req.body;

    const newContract = {
        id: 'ctr_' + Date.now(),
        relatedSchoolId: relatedSchoolId || '',
        relatedSchoolName: relatedSchoolName || '',
        relatedCanteenId: relatedCanteenId || '',
        relatedCanteenName: relatedCanteenName || '',
        ownerId: ownerId || '',
        ownerName: ownerName || '',
        ownerType: ownerType || '',
        contractNo: contractNo || '',
        contractName: contractName || '',
        contractType: contractType || '食材供应合同',
        signDate: signDate || '',
        startDate: startDate || '',
        endDate: endDate || '',
        amount: amount || 0,
        paymentTerms: paymentTerms || '',
        mealStandard: mealStandard || '',
        dinerCount: dinerCount || '',
        status: status || '草稿',
        remarks: remarks || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    contracts.push(newContract);
    writeJSON('contracts.json', contracts);
    res.json(newContract);
});

app.put('/api/contracts/:id', authMiddleware, (req, res) => {
    const contracts = readJSON('contracts.json');
    const idx = contracts.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '合同不存在' });

    const {
        contractNo, contractName, contractType,
        signDate, startDate, endDate, amount, paymentTerms, status, mealStandard, dinerCount, remarks
    } = req.body;

    contracts[idx] = {
        ...contracts[idx],
        contractNo: contractNo !== undefined ? contractNo : contracts[idx].contractNo,
        contractName: contractName !== undefined ? contractName : contracts[idx].contractName,
        contractType: contractType !== undefined ? contractType : contracts[idx].contractType,
        signDate: signDate !== undefined ? signDate : contracts[idx].signDate,
        startDate: startDate !== undefined ? startDate : contracts[idx].startDate,
        endDate: endDate !== undefined ? endDate : contracts[idx].endDate,
        amount: amount !== undefined ? amount : contracts[idx].amount,
        paymentTerms: paymentTerms !== undefined ? paymentTerms : contracts[idx].paymentTerms,
        mealStandard: mealStandard !== undefined ? mealStandard : contracts[idx].mealStandard,
        dinerCount: dinerCount !== undefined ? dinerCount : contracts[idx].dinerCount,
        status: status !== undefined ? status : contracts[idx].status,
        remarks: remarks !== undefined ? remarks : contracts[idx].remarks,
        updatedAt: new Date().toISOString()
    };

    writeJSON('contracts.json', contracts);
    res.json(contracts[idx]);
});

app.delete('/api/contracts/:id', authMiddleware, (req, res) => {
    const contracts = readJSON('contracts.json');
    const filtered = contracts.filter(c => c.id !== req.params.id);
    writeJSON('contracts.json', filtered);
    res.json({ message: '删除成功' });
});

// ============ 公开遴选 API ============

// 辅助函数：校验学校是否可以使用遴选模块
function canUseSelectionModule(school, canteenId) {
    // 检查是否包含校外供餐
    if (school.供餐类型 && school.供餐类型.includes('校外供餐')) {
        return true;
    }
    // 检查是否包含校内供餐 + 自营食堂
    if (school.供餐类型 && school.供餐类型.includes('校内供餐')) {
        if (canteenId) {
            const canteens = readJSON('canteens.json');
            const canteen = canteens.find(c => c.id === canteenId);
            if (canteen && canteen.operationMode === '自营') {
                return true;
            }
        }
    }
    return false;
}

function ensureSelectionWorkflowMutable(announcement, res) {
    try {
        assertWorkflowMutable(announcement.status);
        return true;
    } catch (err) {
        res.status(400).json({ error: err.message });
        return false;
    }
}

// --- 遴选公告 API ---
// 获取遴选公告列表
app.get('/api/selection/announcements', authMiddleware, (req, res) => {
    const announcements = readJSON('selectionAnnouncements.json');
    const user = req.user;

    let filtered = announcements;

    // 学校用户只看本校公告
    if (user.role === 'school') {
        filtered = filtered.filter(a => a.schoolId === user.schoolId || a.schoolId === user.id);
    }
    // 暂不开放企业线上报名，企业端不展示可报名公告
    else if (['ingredientSupplier', 'cateringCompany', 'operationSupplier', 'serviceSupplier'].includes(user.role)) {
        filtered = [];
    }
    // admin 可以看所有

    // 按时间倒序
    filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json(filtered);
});

// 获取单个遴选公告
app.get('/api/selection/announcements/:id', authMiddleware, (req, res) => {
    const announcements = readJSON('selectionAnnouncements.json');
    const announcement = announcements.find(a => a.id === req.params.id);
    if (!announcement) return res.status(404).json({ error: '公告不存在' });
    res.json(announcement);
});

app.get('/api/selection/announcements/:id/workflow', authMiddleware, (req, res) => {
    try {
        const detail = buildSelectionWorkflowDetail({
            announcements: readJSON('selectionAnnouncements.json'),
            registrations: readJSON('selectionRegistrations.json'),
            candidates: readJSON('selectionCandidates.json'),
            inspections: readJSON('selectionInspections.json'),
            shortlisted: readJSON('selectionShortlisted.json'),
            results: readJSON('selectionResults.json'),
            contracts: readJSON('selectionContracts.json')
        }, req.params.id, req.user);

        res.json(detail);
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

// 发起遴选项目
app.post('/api/selection/announcements', authMiddleware, (req, res) => {
    if (!['school', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ error: '无权限' });
    }

    const { canteenId, serviceType, title, content, requirements, publishUrl, registrationDeadline } = req.body;
    const user = req.user;

    // 获取学校信息
    const schools = readJSON('schools.json');
    const school = schools.find(s => s.id === (user.schoolId || user.id));
    if (!school) return res.status(404).json({ error: '学校不存在' });

    // 校验资格
    if (!canUseSelectionModule(school, canteenId)) {
        return res.status(400).json({ error: '该校/食堂不符合遴选条件（仅校外供餐学校或自营食堂可用）' });
    }

    // 获取食堂信息
    let canteenName = '校外供餐';
    if (canteenId) {
        const canteens = readJSON('canteens.json');
        const canteen = canteens.find(c => c.id === canteenId);
        if (canteen) canteenName = canteen.name;
    }

    // 获取所有项目用于生成编号
    const announcements = readJSON('selectionAnnouncements.json');

    // 生成项目编号
    const year = new Date().getFullYear();
    const count = announcements.filter(a => a.announcementNo.includes(year)).length + 1;
    const announcementNo = `XL-${year}-${String(count).padStart(3, '0')}`;

    const newAnnouncement = {
        id: `sel_ann_${Date.now()}`,
        announcementNo,
        projectNo: announcementNo,
        schoolId: user.schoolId || user.id,
        schoolName: school.name,
        canteenId: canteenId || null,
        canteenName,
        serviceType,
        title,
        content: content || '',
        requirements: requirements || '',
        publishUrl: publishUrl || '',
        registrationDeadline: registrationDeadline || '',
        publishTime: null,
        status: '项目已立项',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    announcements.push(newAnnouncement);
    writeJSON('selectionAnnouncements.json', announcements);
    res.json(newAnnouncement);
});

// 更新遴选公告信息
app.put('/api/selection/announcements/:id', authMiddleware, (req, res) => {
    if (!['school', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ error: '无权限' });
    }

    const announcements = readJSON('selectionAnnouncements.json');
    const idx = announcements.findIndex(a => a.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '公告不存在' });

    const announcement = announcements[idx];

    // 只有项目已立项状态可以编辑公告信息，保留草稿兼容旧数据
    if (!['项目已立项', '草稿'].includes(announcement.status)) {
        return res.status(400).json({ error: '只有项目已立项状态可以编辑公告信息' });
    }

    // 学校用户只能编辑自己的公告
    if (req.user.role === 'school' && announcement.schoolId !== (req.user.schoolId || req.user.id)) {
        return res.status(403).json({ error: '无权限' });
    }

    const { title, content, requirements, publishUrl, registrationDeadline } = req.body;
    announcements[idx] = {
        ...announcement,
        title,
        content,
        requirements,
        publishUrl,
        registrationDeadline,
        updatedAt: new Date().toISOString()
    };

    writeJSON('selectionAnnouncements.json', announcements);
    res.json(announcements[idx]);
});

// 发布遴选公告
app.post('/api/selection/announcements/:id/publish', authMiddleware, (req, res) => {
    if (!['school', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ error: '无权限' });
    }

    const announcements = readJSON('selectionAnnouncements.json');
    const idx = announcements.findIndex(a => a.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '公告不存在' });

    const announcement = announcements[idx];
    if (!ensureSelectionWorkflowMutable(announcement, res)) return;

    if (!['项目已立项', '草稿'].includes(announcement.status)) {
        return res.status(400).json({ error: '只有项目已立项状态可以发布公告' });
    }

    try {
        validateAnnouncementPublish(announcement);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    announcements[idx] = {
        ...announcement,
        status: '报名审核中',
        publishTime: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    writeJSON('selectionAnnouncements.json', announcements);
    res.json(announcements[idx]);
});

// 退回遴选流程到前一步
app.post('/api/selection/announcements/:id/rollback', authMiddleware, (req, res) => {
    if (!['school', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ error: '无权限' });
    }

    const { reason } = req.body;
    if (!String(reason || '').trim()) {
        return res.status(400).json({ error: '退回原因必填' });
    }

    const announcements = readJSON('selectionAnnouncements.json');
    const idx = announcements.findIndex(a => a.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '公告不存在' });

    const announcement = announcements[idx];
    if (req.user.role === 'school' && announcement.schoolId !== (req.user.schoolId || req.user.id)) {
        return res.status(403).json({ error: '无权限' });
    }
    if (!ensureSelectionWorkflowMutable(announcement, res)) return;

    const previousStatus = previousSelectionStatus(announcement.status);
    if (!previousStatus) {
        return res.status(400).json({ error: '当前状态不允许退回' });
    }

    const rollbackLog = announcement.rollbackLog || [];
    announcements[idx] = {
        ...announcement,
        status: previousStatus,
        rollbackLog: [
            ...rollbackLog,
            {
                fromStatus: announcement.status,
                toStatus: previousStatus,
                reason: reason.trim(),
                operatorId: req.user.id,
                operatorName: req.user.name,
                operatedAt: new Date().toISOString()
            }
        ],
        updatedAt: new Date().toISOString()
    };

    writeJSON('selectionAnnouncements.json', announcements);
    res.json(announcements[idx]);
});

// 结束遴选公告
app.post('/api/selection/announcements/:id/close', authMiddleware, (req, res) => {
    if (!['school', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ error: '无权限' });
    }

    const announcements = readJSON('selectionAnnouncements.json');
    const idx = announcements.findIndex(a => a.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '公告不存在' });

    announcements[idx] = {
        ...announcements[idx],
        status: '已结束',
        updatedAt: new Date().toISOString()
    };

    writeJSON('selectionAnnouncements.json', announcements);
    res.json(announcements[idx]);
});

// 删除遴选公告
app.delete('/api/selection/announcements/:id', authMiddleware, (req, res) => {
    if (!['school', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ error: '无权限' });
    }

    const announcements = readJSON('selectionAnnouncements.json');
    const announcement = announcements.find(a => a.id === req.params.id);
    if (!announcement) return res.status(404).json({ error: '公告不存在' });

    if (!['项目已立项', '草稿'].includes(announcement.status)) {
        return res.status(400).json({ error: '只有项目已立项状态的项目可以删除' });
    }

    const filtered = announcements.filter(a => a.id !== req.params.id);
    writeJSON('selectionAnnouncements.json', filtered);
    res.json({ message: '删除成功' });
});

// --- 遴选报名 API ---
// 学校录入线下报名企业
app.post('/api/selection/registrations', authMiddleware, (req, res) => {
    const { announcementId, enterpriseId, enterpriseName, contactPerson, contactPhone, contactEmail, attachments } = req.body;
    const user = req.user;

    const isSchool = user.role === 'school';

    if (!isSchool) {
        return res.status(403).json({ error: '无权限创建报名记录' });
    }

    const announcements = readJSON('selectionAnnouncements.json');
    const announcement = announcements.find(a => a.id === announcementId);
    if (!announcement) return res.status(404).json({ error: '公告不存在' });
    if (!ensureSelectionWorkflowMutable(announcement, res)) return;

    if (!['已发布', '报名审核中'].includes(announcement.status)) {
        return res.status(400).json({ error: '当前状态不能录入报名企业' });
    }

    // 检查是否已报名
    const registrations = readJSON('selectionRegistrations.json');
    const checkEnterpriseId = enterpriseId;
    if (!checkEnterpriseId) {
        return res.status(400).json({ error: '请选择报名企业' });
    }
    const existingReg = registrations.find(r => r.announcementId === announcementId && r.enterpriseId === checkEnterpriseId);
    if (existingReg) {
        return res.status(400).json({ error: '该企业已报名此公告' });
    }

    // 获取企业类型
    let enterpriseType = '未知';
    if (enterpriseId?.startsWith('ing_')) {
        enterpriseType = '食材供应商';
    } else if (enterpriseId?.startsWith('cat_')) {
        enterpriseType = '校外供餐企业';
    }

    // 如果是学校创建，从企业表获取企业名称
    let finalEnterpriseName = enterpriseName;
    if (isSchool && enterpriseId) {
        if (enterpriseId.startsWith('ing_')) {
            const suppliers = readJSON('ingredientSuppliers.json');
            const supplier = suppliers.find(s => s.id === enterpriseId);
            if (supplier) finalEnterpriseName = supplier.name;
        } else if (enterpriseId.startsWith('cat_')) {
            const companies = readJSON('cateringCompanies.json');
            const company = companies.find(c => c.id === enterpriseId);
            if (company) finalEnterpriseName = company.name;
        }
    }

    // 生成报名编号
    const year = new Date().getFullYear();
    const count = registrations.filter(r => r.registrationNo.includes(year)).length + 1;
    const registrationNo = `BM-${year}-${String(count).padStart(3, '0')}`;

    const newRegistration = {
        id: `sel_reg_${Date.now()}`,
        registrationNo,
        announcementId,
        announcementTitle: announcement.title,
        enterpriseId: checkEnterpriseId,
        enterpriseName: finalEnterpriseName || enterpriseName,
        enterpriseType: enterpriseType,
        contactPerson: contactPerson || '',
        contactPhone: contactPhone || '',
        contactEmail: contactEmail || '',
        attachments: attachments || [],
        status: '待审核',
        reviewTime: null,
        reviewComments: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    registrations.push(newRegistration);
    writeJSON('selectionRegistrations.json', registrations);

    const annIdx = announcements.findIndex(a => a.id === announcementId);
    if (annIdx !== -1 && announcements[annIdx].status === '已发布') {
        announcements[annIdx].status = '报名审核中';
        announcements[annIdx].updatedAt = new Date().toISOString();
        writeJSON('selectionAnnouncements.json', announcements);
    }

    res.json(newRegistration);
});

// 获取报名列表（学校查看）
app.get('/api/selection/announcements/:announcementId/registrations', authMiddleware, (req, res) => {
    const user = req.user;

    if (!['school', 'admin'].includes(user.role)) {
        return res.status(403).json({ error: '无权限' });
    }

    const registrations = readJSON('selectionRegistrations.json');
    let filtered = registrations.filter(r => r.announcementId === req.params.announcementId);

    // 学校用户只能查看本校公告的报名
    if (user.role === 'school') {
        const announcements = readJSON('selectionAnnouncements.json');
        const announcement = announcements.find(a => a.id === req.params.announcementId);
        if (announcement && announcement.schoolId !== (user.schoolId || user.id)) {
            return res.status(403).json({ error: '无权限' });
        }
    }

    filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(filtered);
});

// 学校审核报名
app.put('/api/selection/registrations/:id/review', authMiddleware, (req, res) => {
    if (!['school', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ error: '无权限' });
    }

    const { status, reviewComments } = req.body;
    try {
        validateRegistrationReview({ status, reviewComments });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    const registrations = readJSON('selectionRegistrations.json');
    const idx = registrations.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '报名不存在' });
    const announcements = readJSON('selectionAnnouncements.json');
    const announcement = announcements.find(a => a.id === registrations[idx].announcementId);
    if (!announcement) return res.status(404).json({ error: '公告不存在' });
    if (!ensureSelectionWorkflowMutable(announcement, res)) return;

    registrations[idx] = {
        ...registrations[idx],
        status,
        reviewComments,
        reviewTime: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    writeJSON('selectionRegistrations.json', registrations);
    res.json(registrations[idx]);
});

// 企业查看自己的报名
app.get('/api/selection/my-registrations', authMiddleware, (req, res) => {
    const user = req.user;

    if (!['ingredientSupplier', 'cateringCompany', 'operationSupplier', 'serviceSupplier'].includes(user.role)) {
        return res.status(403).json({ error: '无权限' });
    }

    const registrations = readJSON('selectionRegistrations.json');
    const filtered = registrations.filter(r => r.enterpriseId === user.id);
    filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(filtered);
});

// --- 备选企业确认 API ---
// 确认备选企业
app.post('/api/selection/candidates', authMiddleware, (req, res) => {
    if (!['school', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ error: '无权限' });
    }

    const { announcementId, enterpriseIds } = req.body;

    const announcements = readJSON('selectionAnnouncements.json');
    const announcement = announcements.find(a => a.id === announcementId);
    if (!announcement) return res.status(404).json({ error: '公告不存在' });
    if (!ensureSelectionWorkflowMutable(announcement, res)) return;

    // 获取已受理的企业
    const registrations = readJSON('selectionRegistrations.json');
    const acceptedRegs = registrations.filter(r =>
        r.announcementId === announcementId && ['审核通过', '已受理'].includes(r.status)
    );
    const selectedEnterpriseIds = enterpriseIds || [];

    try {
        validateCandidateSelection({
            acceptedCount: acceptedRegs.length,
            selectedCount: selectedEnterpriseIds.length
        });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    const confirmedEnterprises = acceptedRegs
        .filter(r => selectedEnterpriseIds.includes(r.enterpriseId))
        .map(r => ({
            enterpriseId: r.enterpriseId,
            enterpriseName: r.enterpriseName,
            enterpriseType: r.enterpriseType,
            confirmedAt: new Date().toISOString()
        }));

    const newCandidate = {
        id: `sel_cand_${Date.now()}`,
        announcementId,
        schoolId: req.user.schoolId || req.user.id,
        schoolName: announcement.schoolName,
        confirmedEnterprises,
        determinationMethod: '线下随机确定',
        confirmationTime: new Date().toISOString(),
        status: '已确认',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    const candidates = readJSON('selectionCandidates.json');
    candidates.push(newCandidate);
    writeJSON('selectionCandidates.json', candidates);

    // 更新公告状态为遴选中
    const annIdx = announcements.findIndex(a => a.id === announcementId);
    if (annIdx !== -1) {
        announcements[annIdx].status = '考察中';
        announcements[annIdx].updatedAt = new Date().toISOString();
        writeJSON('selectionAnnouncements.json', announcements);
    }

    res.json(newCandidate);
});

// 获取备选企业列表
app.get('/api/selection/candidates', authMiddleware, (req, res) => {
    const user = req.user;

    if (!['school', 'admin'].includes(user.role)) {
        return res.status(403).json({ error: '无权限' });
    }

    const candidates = readJSON('selectionCandidates.json');
    let filtered = candidates;

    if (user.role === 'school') {
        filtered = filtered.filter(c => c.schoolId === (user.schoolId || user.id));
    }

    filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(filtered);
});

// --- 考察记录 API ---
// 创建考察记录
app.post('/api/selection/inspections', authMiddleware, (req, res) => {
    if (!['school', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ error: '无权限' });
    }

    const { announcementId, enterpriseId, enterpriseName, inspectionTime, inspectionLocation, inspectors, inspectionResult, attachments } = req.body;

    const registrations = readJSON('selectionRegistrations.json');
    const registration = registrations.find(r => r.announcementId === announcementId && r.enterpriseId === enterpriseId);
    if (!registration) return res.status(404).json({ error: '报名记录不存在' });
    const announcements = readJSON('selectionAnnouncements.json');
    const announcement = announcements.find(a => a.id === announcementId);
    if (!announcement) return res.status(404).json({ error: '公告不存在' });
    if (!ensureSelectionWorkflowMutable(announcement, res)) return;

    // 生成考察编号
    const year = new Date().getFullYear();
    const inspections = readJSON('selectionInspections.json');
    const count = inspections.filter(i => i.inspectionNo && i.inspectionNo.includes(year)).length + 1;
    const inspectionNo = `KC-${year}-${String(count).padStart(3, '0')}`;

    const newInspection = {
        id: `sel_insp_${Date.now()}`,
        inspectionNo,
        announcementId,
        enterpriseId,
        enterpriseName,
        inspectionTime,
        inspectionLocation,
        inspectors,
        inspectionResult,
        attachments: attachments || [],
        passed: null,
        passTime: null,
        passComments: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    inspections.push(newInspection);
    writeJSON('selectionInspections.json', inspections);
    res.json(newInspection);
});

// 获取考察记录列表
app.get('/api/selection/inspections', authMiddleware, (req, res) => {
    const user = req.user;

    if (!['school', 'admin'].includes(user.role)) {
        return res.status(403).json({ error: '无权限' });
    }

    let inspections = readJSON('selectionInspections.json');

    if (user.role === 'school') {
        const candidates = readJSON('selectionCandidates.json');
        const schoolCandidates = candidates.filter(c => c.schoolId === (user.schoolId || user.id));
        const announcementIds = schoolCandidates.map(c => c.announcementId);
        inspections = inspections.filter(i => announcementIds.includes(i.announcementId));
    }

    inspections.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(inspections);
});

// 更新考察记录
app.put('/api/selection/inspections/:id', authMiddleware, (req, res) => {
    if (!['school', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ error: '无权限' });
    }

    const inspections = readJSON('selectionInspections.json');
    const idx = inspections.findIndex(i => i.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '考察记录不存在' });
    const announcements = readJSON('selectionAnnouncements.json');
    const announcement = announcements.find(a => a.id === inspections[idx].announcementId);
    if (!announcement) return res.status(404).json({ error: '公告不存在' });
    if (!ensureSelectionWorkflowMutable(announcement, res)) return;

    const { inspectionTime, inspectionLocation, inspectors, inspectionResult, attachments } = req.body;
    inspections[idx] = {
        ...inspections[idx],
        inspectionTime,
        inspectionLocation,
        inspectors,
        inspectionResult,
        attachments: attachments || inspections[idx].attachments,
        updatedAt: new Date().toISOString()
    };

    writeJSON('selectionInspections.json', inspections);
    res.json(inspections[idx]);
});

// 考察通过
app.post('/api/selection/inspections/:id/pass', authMiddleware, (req, res) => {
    if (!['school', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ error: '无权限' });
    }

    const inspections = readJSON('selectionInspections.json');
    const idx = inspections.findIndex(i => i.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '考察记录不存在' });
    const announcements = readJSON('selectionAnnouncements.json');
    const announcement = announcements.find(a => a.id === inspections[idx].announcementId);
    if (!announcement) return res.status(404).json({ error: '公告不存在' });
    if (!ensureSelectionWorkflowMutable(announcement, res)) return;

    inspections[idx] = {
        ...inspections[idx],
        passed: true,
        passTime: new Date().toISOString(),
        passComments: req.body.comments || '',
        updatedAt: new Date().toISOString()
    };

    writeJSON('selectionInspections.json', inspections);
    res.json(inspections[idx]);
});

// 考察不通过
app.post('/api/selection/inspections/:id/fail', authMiddleware, (req, res) => {
    if (!['school', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ error: '无权限' });
    }

    const inspections = readJSON('selectionInspections.json');
    const idx = inspections.findIndex(i => i.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '考察记录不存在' });
    const announcements = readJSON('selectionAnnouncements.json');
    const announcement = announcements.find(a => a.id === inspections[idx].announcementId);
    if (!announcement) return res.status(404).json({ error: '公告不存在' });
    if (!ensureSelectionWorkflowMutable(announcement, res)) return;

    inspections[idx] = {
        ...inspections[idx],
        passed: false,
        passTime: new Date().toISOString(),
        passComments: req.body.comments || '',
        updatedAt: new Date().toISOString()
    };

    writeJSON('selectionInspections.json', inspections);
    res.json(inspections[idx]);
});

// --- 入围企业 API ---
// 确定入围企业
app.post('/api/selection/shortlisted', authMiddleware, (req, res) => {
    if (!['school', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ error: '无权限' });
    }

    const { announcementId, enterpriseIds } = req.body;

    const announcements = readJSON('selectionAnnouncements.json');
    const announcement = announcements.find(a => a.id === announcementId);
    if (!announcement) return res.status(404).json({ error: '公告不存在' });
    if (!ensureSelectionWorkflowMutable(announcement, res)) return;

    // 获取考察通过的企业
    const inspections = readJSON('selectionInspections.json');
    const passedInspections = inspections.filter(i => i.announcementId === announcementId && i.passed === true);
    const selectedEnterpriseIds = enterpriseIds || [];

    try {
        validateShortlistSelection({
            passedCount: passedInspections.length,
            selectedCount: selectedEnterpriseIds.length
        });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    const shortlistedEnterprises = passedInspections
        .filter(i => selectedEnterpriseIds.includes(i.enterpriseId))
        .map(i => ({
            enterpriseId: i.enterpriseId,
            enterpriseName: i.enterpriseName,
            enterpriseType: i.enterpriseType,
            shortlistedAt: new Date().toISOString()
        }));

    const newShortlisted = {
        id: `sel_short_${Date.now()}`,
        announcementId,
        schoolId: req.user.schoolId || req.user.id,
        schoolName: announcement.schoolName,
        shortlistedEnterprises,
        shortlistTime: new Date().toISOString(),
        status: '已确定',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    const shortlisted = readJSON('selectionShortlisted.json');
    shortlisted.push(newShortlisted);
    writeJSON('selectionShortlisted.json', shortlisted);

    const annIdx = announcements.findIndex(a => a.id === announcementId);
    if (annIdx !== -1) {
        announcements[annIdx].status = '家长投票中';
        announcements[annIdx].updatedAt = new Date().toISOString();
        writeJSON('selectionAnnouncements.json', announcements);
    }

    res.json(newShortlisted);
});

// 获取入围企业列表
app.get('/api/selection/shortlisted', authMiddleware, (req, res) => {
    const user = req.user;

    if (!['school', 'admin'].includes(user.role)) {
        return res.status(403).json({ error: '无权限' });
    }

    let shortlisted = readJSON('selectionShortlisted.json');

    if (user.role === 'school') {
        shortlisted = shortlisted.filter(s => s.schoolId === (user.schoolId || user.id));
    }

    shortlisted.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(shortlisted);
});

// --- 中标结果 API ---
// 确定中标结果
app.post('/api/selection/results', authMiddleware, (req, res) => {
    if (!['school', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ error: '无权限' });
    }

    const {
        announcementId,
        winningEnterprise,
        voteResults,
        voteTime,
        voteLocation,
        parentAttendance,
        validVotes,
        roundNo,
        determinationBy,
        parentRepresentatives,
        remarks
    } = req.body;

    const announcements = readJSON('selectionAnnouncements.json');
    const announcement = announcements.find(a => a.id === announcementId);
    if (!announcement) return res.status(404).json({ error: '公告不存在' });
    if (!ensureSelectionWorkflowMutable(announcement, res)) return;

    try {
        validateVotingMetadata({ voteResults, validVotes, voteTime, voteLocation, parentAttendance });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    const results = readJSON('selectionResults.json');
    const existingRounds = results.filter(r => r.announcementId === announcementId);
    const currentRoundNo = Number(roundNo || existingRounds.length + 1);
    let finalWinningEnterprise = winningEnterprise;
    let resultStatus = '已确定';
    let revoteEnterprises = [];
    try {
        finalWinningEnterprise = determineVotingWinner(voteResults || []);
    } catch (err) {
        resultStatus = '需二次投票';
        revoteEnterprises = err.revoteEnterprises || [];
        finalWinningEnterprise = null;
    }

    const newResult = {
        id: `sel_res_${Date.now()}`,
        announcementId,
        schoolId: req.user.schoolId || req.user.id,
        schoolName: announcement.schoolName,
        roundNo: currentRoundNo,
        status: resultStatus,
        winningEnterprise: finalWinningEnterprise ? {
            enterpriseId: finalWinningEnterprise.enterpriseId,
            enterpriseName: finalWinningEnterprise.enterpriseName,
            votes: finalWinningEnterprise.votes,
            totalVotes: finalWinningEnterprise.totalVotes,
            voteRatio: finalWinningEnterprise.voteRatio
        } : null,
        voteResults: voteResults || [],
        voteTime: voteTime || new Date().toISOString().split('T')[0],
        voteLocation: voteLocation || '',
        parentAttendance: Number(parentAttendance || 0),
        validVotes: Number(validVotes || 0),
        revoteEnterprises,
        determinationMethod: '投票',
        determinationTime: new Date().toISOString(),
        determinationBy,
        parentRepresentatives: parentRepresentatives || [],
        remarks: remarks || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    results.push(newResult);
    writeJSON('selectionResults.json', results);

    if (resultStatus === '已确定') {
        // 更新公告状态为待签合同
        const annIdx = announcements.findIndex(a => a.id === announcementId);
        if (annIdx !== -1) {
            announcements[annIdx].status = '待签合同';
            writeJSON('selectionAnnouncements.json', announcements);
        }
    }

    res.json(newResult);
});

// 获取中标结果列表
app.get('/api/selection/results', authMiddleware, (req, res) => {
    const user = req.user;

    if (!['school', 'admin'].includes(user.role)) {
        return res.status(403).json({ error: '无权限' });
    }

    let results = readJSON('selectionResults.json');

    if (user.role === 'school') {
        results = results.filter(r => r.schoolId === (user.schoolId || user.id));
    }

    results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(results);
});

// --- 遴选合同 API ---
// 创建遴选合同
app.post('/api/selection/contracts', authMiddleware, (req, res) => {
    if (!['school', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ error: '无权限' });
    }

    const { announcementId, resultId, canteenId, canteenName, enterpriseId, enterpriseName, contractStartDate, contractEndDate, contractAmount, contractUnit, contractFileUrl, signDate, paymentTerms, mealStandard, dinerCount, remarks } = req.body;

    // 生成合同编号
    const year = new Date().getFullYear();
    const contracts = readJSON('selectionContracts.json');
    const count = contracts.filter(c => c.contractNo && c.contractNo.includes(year)).length + 1;
    const contractNo = `XL-CTR-${year}-${String(count).padStart(3, '0')}`;

    const announcements = readJSON('selectionAnnouncements.json');
    const announcement = announcements.find(a => a.id === announcementId);
    if (!announcement) return res.status(404).json({ error: '公告不存在' });
    if (!ensureSelectionWorkflowMutable(announcement, res)) return;

    const newContract = {
        id: `sel_ctr_${Date.now()}`,
        contractNo,
        announcementId,
        resultId,
        schoolId: req.user.schoolId || req.user.id,
        schoolName: announcement ? announcement.schoolName : '',
        canteenId: canteenId || null,
        canteenName: canteenName || '',
        enterpriseId,
        enterpriseName,
        contractStartDate,
        contractEndDate,
        contractAmount,
        contractUnit: contractUnit || '万元/年',
        contractFileUrl: contractFileUrl || '',
        paymentTerms: paymentTerms || '',
        mealStandard: mealStandard || '',
        dinerCount: dinerCount || '',
        status: '已签订',
        signDate: signDate || new Date().toISOString().split('T')[0],
        remarks: remarks || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    contracts.push(newContract);
    writeJSON('selectionContracts.json', contracts);

    const linkedContracts = readJSON('contracts.json');
    linkedContracts.push({
        id: `ctr_${Date.now()}`,
        source: 'selection',
        selectionContractId: newContract.id,
        selectionAnnouncementId: announcementId,
        selectionResultId: resultId,
        schoolId: newContract.schoolId,
        relatedSchoolId: newContract.schoolId,
        relatedSchoolName: newContract.schoolName,
        relatedCanteenId: canteenId || '',
        relatedCanteenName: canteenName || announcement.canteenName || '',
        ownerId: enterpriseId || '',
        ownerName: enterpriseName || '',
        ownerType: '校外供餐企业',
        contractNo,
        contractName: `${announcement.title || '公开遴选'}遴选合同`,
        contractType: '公开遴选供餐合同',
        signDate: newContract.signDate,
        startDate: contractStartDate || '',
        endDate: contractEndDate || '',
        amount: contractAmount || 0,
        paymentTerms: paymentTerms || '',
        mealStandard: mealStandard || '',
        dinerCount: dinerCount || '',
        status: '有效',
        remarks: remarks || '',
        createdAt: newContract.createdAt,
        updatedAt: newContract.updatedAt
    });
    writeJSON('contracts.json', linkedContracts);

    const annIdx = announcements.findIndex(a => a.id === announcementId);
    if (annIdx !== -1) {
        announcements[annIdx].status = '已完成';
        announcements[annIdx].updatedAt = new Date().toISOString();
        writeJSON('selectionAnnouncements.json', announcements);
    }

    res.json(newContract);
});

// 获取遴选合同列表
app.get('/api/selection/contracts', authMiddleware, (req, res) => {
    const user = req.user;

    let contracts = readJSON('selectionContracts.json');

    if (user.role === 'school') {
        contracts = contracts.filter(c => c.schoolId === (user.schoolId || user.id));
    } else if (['ingredientSupplier', 'cateringCompany', 'operationSupplier', 'serviceSupplier'].includes(user.role)) {
        contracts = contracts.filter(c => c.enterpriseId === user.id);
    }
    // admin 可以看所有

    contracts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(contracts);
});

// 更新遴选合同
app.put('/api/selection/contracts/:id', authMiddleware, (req, res) => {
    if (!['school', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ error: '无权限' });
    }

    const contracts = readJSON('selectionContracts.json');
    const idx = contracts.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '合同不存在' });

    const { contractStartDate, contractEndDate, contractAmount, contractUnit, contractFileUrl, signDate, paymentTerms, mealStandard, dinerCount, remarks, status } = req.body;
    contracts[idx] = {
        ...contracts[idx],
        contractStartDate: contractStartDate || contracts[idx].contractStartDate,
        contractEndDate: contractEndDate || contracts[idx].contractEndDate,
        contractAmount: contractAmount !== undefined ? contractAmount : contracts[idx].contractAmount,
        contractUnit: contractUnit || contracts[idx].contractUnit,
        contractFileUrl: contractFileUrl !== undefined ? contractFileUrl : contracts[idx].contractFileUrl,
        signDate: signDate || contracts[idx].signDate,
        paymentTerms: paymentTerms !== undefined ? paymentTerms : contracts[idx].paymentTerms,
        mealStandard: mealStandard !== undefined ? mealStandard : contracts[idx].mealStandard,
        dinerCount: dinerCount !== undefined ? dinerCount : contracts[idx].dinerCount,
        remarks: remarks !== undefined ? remarks : contracts[idx].remarks,
        status: status || contracts[idx].status,
        updatedAt: new Date().toISOString()
    };

    writeJSON('selectionContracts.json', contracts);
    res.json(contracts[idx]);
});

// 签订遴选合同
app.post('/api/selection/contracts/:id/sign', authMiddleware, (req, res) => {
    if (!['school', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ error: '无权限' });
    }

    const contracts = readJSON('selectionContracts.json');
    const idx = contracts.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '合同不存在' });

    contracts[idx] = {
        ...contracts[idx],
        status: '已签订',
        updatedAt: new Date().toISOString()
    };

    writeJSON('selectionContracts.json', contracts);
    res.json(contracts[idx]);
});

// 终止遴选合同
app.post('/api/selection/contracts/:id/terminate', authMiddleware, (req, res) => {
    if (!['school', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ error: '无权限' });
    }

    const contracts = readJSON('selectionContracts.json');
    const idx = contracts.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '合同不存在' });

    contracts[idx] = {
        ...contracts[idx],
        status: '已终止',
        updatedAt: new Date().toISOString()
    };

    writeJSON('selectionContracts.json', contracts);
    res.json(contracts[idx]);
});

// --- 企业证照管理 API ---
// 获取当前企业的证照列表
app.get('/api/enterprise-licenses', authMiddleware, (req, res) => {
    const licenses = readJSON('enterpriseLicenses.json');
    const user = req.user;

    // 过滤出属于该企业的证照
    // admin角色可以看到所有证照，其他角色只看自己的
    let filtered;
    if (user.role === 'admin') {
        filtered = licenses; // 管理员看到所有证照
    } else {
        const enterprise = findEnterpriseRecordForLicense(user);
        const enterpriseId = enterprise?.id || user.id;
        filtered = licenses.filter(l => l.enterpriseId === enterpriseId);
    }
    res.json(filtered);
});

// 新增证照
app.post('/api/enterprise-licenses', authMiddleware, (req, res) => {
    const licenses = readJSON('enterpriseLicenses.json');
    const user = req.user;

    const enterprise = findEnterpriseRecordForLicense(user, req.body.enterpriseId);
    if (user.role === 'admin' && !enterprise) {
        return res.status(400).json({ error: '请选择有效的所属企业' });
    }
    const enterpriseId = enterprise?.id || user.id;
    const enterpriseName = enterprise?.name || user.name || '';
    const enterpriseType = enterprise?.enterpriseType || '企业';

    const now = new Date().toISOString();
    const normalizedInput = normalizeEnterpriseLicenseInput({
        ...req.body,
        enterpriseName: req.body.enterpriseName || req.body.name || enterpriseName
    });
    const validation = validateEnterpriseLicenseInput(normalizedInput, { enterpriseId, enterpriseName, enterpriseType });
    if (!validation.valid) {
        return res.status(400).json({ error: '证照信息校验失败', errors: validation.errors, warnings: validation.warnings });
    }

    const duplicate = licenses.find(l =>
        l.enterpriseId === enterpriseId &&
        normalizeLicenseType(l.type) === validation.data.type &&
        l.licenseNo === validation.data.licenseNo &&
        (l.status || LICENSE_STATUSES.CURRENT) === LICENSE_STATUSES.CURRENT
    );

    if (duplicate && !req.body.confirmDuplicate) {
        return res.status(409).json({
            error: '可能重复上传同一证照',
            duplicateId: duplicate.id,
            requiresConfirmation: true
        });
    }

    const license = {
        id: 'el_' + Date.now(),
        enterpriseId,
        enterpriseName,
        enterpriseType,
        ...validation.data,
        createdAt: now,
        updatedAt: now
    };
    const versioned = applyLicenseVersioning(licenses, license, now);
    writeJSON('enterpriseLicenses.json', versioned.licenses);
    syncEnterpriseRecordWithLicense(versioned.license);
    res.json({ license: versioned.license, replacedIds: versioned.replacedIds, warnings: validation.warnings });
});

// 删除证照
app.delete('/api/enterprise-licenses/:id', authMiddleware, (req, res) => {
    const licenses = readJSON('enterpriseLicenses.json');
    const license = licenses.find(l => l.id === req.params.id);

    if (!license) {
        return res.status(404).json({ error: '证照不存在' });
    }

    // 验证权限：只能删除属于自己的证照（通过enterpriseId匹配用户ID或企业记录ID）
    const user = req.user;
    let userEnterpriseId = user.id;

    if (user.role === 'ingredientSupplier') {
        const suppliers = readJSON('ingredientSuppliers.json');
        const supplier = suppliers.find(s => s.userId === user.id) || suppliers.find(s => s.name === user.name);
        if (supplier) userEnterpriseId = supplier.id;
    } else if (user.role === 'cateringCompany') {
        const companies = readJSON('cateringCompanies.json');
        const company = companies.find(c => c.userId === user.id) || companies.find(c => c.name === user.name);
        if (company) userEnterpriseId = company.id;
    } else if (user.role === 'operationSupplier') {
        const suppliers = readJSON('operationSuppliers.json');
        const supplier = suppliers.find(s => s.userId === user.id) || suppliers.find(s => s.name === user.name);
        if (supplier) userEnterpriseId = supplier.id;
    } else if (user.role === 'serviceSupplier') {
        const suppliers = readJSON('serviceSuppliers.json');
        const supplier = suppliers.find(s => s.userId === user.id) || suppliers.find(s => s.name === user.name);
        if (supplier) userEnterpriseId = supplier.id;
    }

    // admin角色可以删除任何证照
    if (user.role !== 'admin' && license.enterpriseId !== userEnterpriseId) {
        return res.status(403).json({ error: '无权删除此证照' });
    }

    const now = new Date().toISOString();
    const updated = licenses.map(l => l.id === req.params.id ? {
        ...l,
        status: LICENSE_STATUSES.VOIDED,
        voidedAt: now,
        voidReason: req.body?.reason || '用户作废',
        updatedAt: now
    } : l);
    writeJSON('enterpriseLicenses.json', updated);
    res.json({ message: '删除成功' });
});

// --- 图片上传 API ---
// 确保上传目录存在
const uploadDir = path.join(__dirname, 'uploads/license-images');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// 提供上传文件的静态访问
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 图片上传处理
app.post('/api/enterprise-licenses/upload', upload.single('file'), authMiddleware, (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: '请上传图片文件' });
    }

    // 验证文件类型
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'image/gif', 'application/pdf'];
    if (!allowedTypes.includes(req.file.mimetype)) {
        return res.status(400).json({ error: '只支持 JPG、PNG、GIF、PDF 格式' });
    }

    // 生成唯一文件名
    const ext = path.extname(req.file.originalname);
    const filename = `license_${Date.now()}_${Math.random().toString(36).substring(7)}${ext}`;
    const filepath = path.join(uploadDir, filename);

    // 写入文件
    fs.writeFileSync(filepath, req.file.buffer);

    // 返回文件URL
    const fileUrl = `/uploads/license-images/${filename}`;
    res.json({ url: fileUrl, filename: filename });
});

// 删除图片文件
app.delete('/api/enterprise-licenses/upload/:filename', authMiddleware, (req, res) => {
    const filename = req.params.filename;
    const filepath = path.join(uploadDir, filename);

    if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
    }
    res.json({ message: '删除成功' });
});

// --- OCR识别API ---
async function runBusinessLicenseOcr(payload) {
    const imageData = await getOcrImageBase64(payload);
    const ocrData = await callBaiduOcr(BAIDU_OCR_ENDPOINTS.businessLicense, imageData);
    return ocrParser.parseBaiduOcrResult(ocrData);
}

async function runGeneralOcr(payload) {
    const imageData = await getOcrImageBase64(payload);
    const ocrData = await callBaiduOcr(BAIDU_OCR_ENDPOINTS.generalBasic, imageData, {
        detect_direction: 'true',
        recognize_granularity: 'small'
    });
    return {
        text: ocrData.words_result ? ocrData.words_result.map(w => w.words).join('\n') : '',
        words_result: ocrData.words_result || []
    };
}

async function runFoodLicenseOcr(payload) {
    const imageData = await getOcrImageBase64(payload);
    let specializedResult = null;
    try {
        const ocrData = await callBaiduOcr(BAIDU_OCR_ENDPOINTS.foodBusinessLicense, imageData);
        specializedResult = ocrParser.parseGeneralOcrForFoodLicense(ocrData);
    } catch (err) {
        console.log('食品经营许可证专用OCR失败，尝试通用OCR:', err.message);
    }

    if (specializedResult && getFoodOcrQualityScore(specializedResult) >= 6) {
        return specializedResult;
    }

    const generalData = await callBaiduOcr(BAIDU_OCR_ENDPOINTS.generalBasic, imageData, {
        detect_direction: 'true',
        recognize_granularity: 'small'
    });
    const generalResult = ocrParser.parseGeneralOcrForFoodLicense(generalData);
    if (!specializedResult || getFoodOcrQualityScore(generalResult) >= getFoodOcrQualityScore(specializedResult)) {
        return generalResult;
    }
    return specializedResult;
}

function getFoodOcrQualityScore(result) {
    if (!result) return 0;
    let score = 0;
    if (result.name && /(公司|店|学校|幼儿园|食堂|餐厅|中心)/.test(result.name)) score += 1;
    if (/^JY[0-9A-Z]{10,20}$/i.test(result.licenseNo || '')) score += 2;
    if (result.legalPerson && !/[:：无]/.test(result.legalPerson)) score += 1;
    if (result.address && /(省|市|县|区|路|街|镇|村|号|楼)/.test(result.address)) score += 1;
    if (result.validUntil) score += 1;
    if (result.businessScope && /(食品|热食|冷藏|餐饮)/.test(result.businessScope)) score += 1;
    if (result.subjectType && /(餐饮|食堂|经营者|单位)/.test(result.subjectType)) score += 1;
    if (result.issueAuthority && /市场监督/.test(result.issueAuthority)) score += 1;
    if (result.supervisionAgency && /市场监督/.test(result.supervisionAgency)) score += 1;
    return score;
}

function extractRecognizedText(ocrResult) {
    if (!ocrResult) return '';
    if (ocrResult.text) return ocrResult.text;
    if (Array.isArray(ocrResult.words_result)) {
        return ocrResult.words_result.map(item => item.words || item.word || '').filter(Boolean).join('\n');
    }
    if (ocrResult.words_result && typeof ocrResult.words_result === 'object') {
        return Object.entries(ocrResult.words_result)
            .map(([key, value]) => `${key}: ${Array.isArray(value) ? (value[0]?.word || value[0]?.words || '') : (value?.word || value?.words || value || '')}`)
            .filter(Boolean)
            .join('\n');
    }
    return [
        ocrResult.name,
        ocrResult.licenseNo,
        ocrResult.type,
        ocrResult.legalPerson,
        ocrResult.businessScope
    ].filter(Boolean).join('\n');
}

function comparableLicenseName(value) {
    return String(value || '')
        .replace(/营业执照|食品经营许可证|正本|副本/g, '')
        .replace(/\s+/g, '')
        .trim();
}

function extractFoodLicenseNoTail(text) {
    const lines = String(text || '').split(/\r?\n/);
    const labelIndex = lines.findIndex(line => line.replace(/\s+/g, '').includes('许可证编号'));
    if (labelIndex >= 0) {
        for (let i = labelIndex + 1; i < lines.length && i <= labelIndex + 8; i++) {
            const value = lines[i].replace(/[^0-9A-Za-z]/g, '').toUpperCase();
            if (/^[0-9A-Z]{6,18}$/.test(value)) {
                return value.startsWith('JY') ? '' : value;
            }
        }
    }

    const compactText = String(text || '').replace(/\s+/g, '');
    const labeled = compactText.match(/许可证编号[:：]?([0-9A-Z]{6,18})/i);
    if (!labeled) return '';
    const value = labeled[1].toUpperCase();
    return value.startsWith('JY') ? '' : value;
}

function completeFoodLicenseNoFromHistory(result, recognizedText) {
    if (normalizeLicenseType(result?.type) !== LICENSE_TYPES.FOOD) return result;
    if (/^JY[0-9A-Z]{10,20}$/i.test(result?.licenseNo || '')) return result;

    const tail = extractFoodLicenseNoTail(recognizedText);
    const currentName = comparableLicenseName(result?.enterpriseName || result?.name);
    if (!tail || !currentName) return result;

    const matches = readJSON('enterpriseLicenses.json').filter(license => {
        const licenseNo = String(license.licenseNo || '').toUpperCase();
        if (normalizeLicenseType(license.type) !== LICENSE_TYPES.FOOD) return false;
        if (!/^JY[0-9A-Z]{10,20}$/.test(licenseNo)) return false;
        if (!licenseNo.endsWith(tail)) return false;

        const historyName = comparableLicenseName(license.enterpriseName || license.name);
        return historyName === currentName || historyName.includes(currentName) || currentName.includes(historyName);
    });

    const uniqueNos = [...new Set(matches.map(license => String(license.licenseNo || '').toUpperCase()))];
    if (uniqueNos.length !== 1) return result;
    return { ...result, licenseNo: uniqueNos[0] };
}

function toUnifiedOcrPayload(result, preferredType) {
    const recognizedText = extractRecognizedText(result);
    const completedResult = completeFoodLicenseNoFromHistory(result, recognizedText);
    const detected = detectLicenseTypeFromText(`${recognizedText}\n${completedResult?.type || ''}`);
    const normalizedPreferred = normalizeLicenseType(preferredType || '');
    const suggestedType = [LICENSE_TYPES.BUSINESS, LICENSE_TYPES.FOOD].includes(normalizedPreferred)
        ? normalizedPreferred
        : normalizeLicenseType(completedResult?.type || detected.suggestedType || '');
    return {
        suggestedType,
        confidence: detected.confidence,
        fields: normalizeEnterpriseLicenseInput({
            type: suggestedType,
            enterpriseName: completedResult?.enterpriseName || completedResult?.name,
            licenseNo: completedResult?.licenseNo,
            legalPerson: completedResult?.legalPerson,
            validFrom: completedResult?.validFrom,
            validUntil: completedResult?.validUntil,
            businessScope: completedResult?.businessScope,
            address: completedResult?.address,
            issueAuthority: completedResult?.issueAuthority,
            issueDate: completedResult?.issueDate,
            establishDate: completedResult?.establishDate,
            subjectType: completedResult?.subjectType,
            supervisionAgency: completedResult?.supervisionAgency,
            imageUrl: completedResult?.imageUrl
        }),
        recognizedText
    };
}

app.post('/api/enterprise-licenses/ocr', authMiddleware, async (req, res) => {
    try {
        const { preferredType, imageUrl, imageBase64 } = req.body;
        const payload = { imageUrl, imageBase64 };
        const normalizedPreferred = normalizeLicenseType(preferredType);

        if (normalizedPreferred === LICENSE_TYPES.FOOD) {
            const result = await runFoodLicenseOcr(payload);
            return res.json(toUnifiedOcrPayload(result, LICENSE_TYPES.FOOD));
        }

        if (normalizedPreferred === LICENSE_TYPES.BUSINESS) {
            const result = await runBusinessLicenseOcr(payload);
            return res.json(toUnifiedOcrPayload(result, LICENSE_TYPES.BUSINESS));
        }

        const general = await runGeneralOcr(payload);
        const detected = detectLicenseTypeFromText(general.text);
        const targetType = detected.suggestedType || LICENSE_TYPES.BUSINESS;
        const result = targetType === LICENSE_TYPES.FOOD
            ? await runFoodLicenseOcr(payload)
            : await runBusinessLicenseOcr(payload);
        return res.json(toUnifiedOcrPayload(result, targetType));
    } catch (err) {
        console.error('统一OCR识别错误:', err);
        res.status(500).json({ error: err.message || 'OCR识别失败' });
    }
});

// 百度营业执照OCR识别
app.post('/api/ocr/business-license', authMiddleware, async (req, res) => {
    try {
        if (!OCR_CONFIG.baidu.enabled) {
            return res.status(400).json({ error: '百度OCR未启用，请联系管理员配置' });
        }

        const imageData = await getOcrImageBase64(req.body);

        // 调用百度OCR API - 营业执照识别
        const ocrData = await callBaiduOcr(BAIDU_OCR_ENDPOINTS.businessLicense, imageData);

        // 解析百度OCR返回的数据
        const result = ocrParser.parseBaiduOcrResult(ocrData);
        res.json(result);
    } catch (err) {
        console.error('OCR识别错误:', err);
        res.status(500).json({ error: err.message || 'OCR识别失败' });
    }
});

// 通用文字OCR识别（备用）
app.post('/api/ocr/general', authMiddleware, async (req, res) => {
    try {
        if (!OCR_CONFIG.baidu.enabled) {
            return res.status(400).json({ error: '百度OCR未启用，请联系管理员配置' });
        }

        const imageData = await getOcrImageBase64(req.body);

        // 调用百度OCR API - 通用文字识别
        const ocrData = await callBaiduOcr(BAIDU_OCR_ENDPOINTS.generalBasic, imageData, {
            detect_direction: 'true',
            recognize_granularity: 'small'
        });

        // 提取所有文字
        let text = '';
        if (ocrData.words_result) {
            text = ocrData.words_result.map(w => w.words).join('\n');
        }

        res.json({ text });
    } catch (err) {
        console.error('OCR识别错误:', err);
        res.status(500).json({ error: err.message || 'OCR识别失败' });
    }
});

// 食品经营许可证OCR识别（使用通用文字识别+智能解析）
app.post('/api/ocr/food-license', authMiddleware, async (req, res) => {
    try {
        if (!OCR_CONFIG.baidu.enabled) {
            return res.status(400).json({ error: '百度OCR未启用，请联系管理员配置' });
        }

        const imageData = await getOcrImageBase64(req.body);

        let ocrData;
        try {
            // 优先使用百度食品经营许可证专用接口。
            ocrData = await callBaiduOcr(BAIDU_OCR_ENDPOINTS.foodBusinessLicense, imageData);
        } catch (err) {
            console.log('食品经营许可证专用OCR失败，尝试通用OCR:', err.message);
            ocrData = await callBaiduOcr(BAIDU_OCR_ENDPOINTS.accurateBasic, imageData, {
                detect_direction: 'true',
                recognize_granularity: 'small'
            });
        }

        // 解析通用OCR结果，提取食品许可证字段
        const result = ocrParser.parseGeneralOcrForFoodLicense(ocrData);
        res.json(result);
    } catch (err) {
        console.error('食品OCR识别错误:', err);
        res.status(500).json({ error: err.message || 'OCR识别失败' });
    }
});

// --- Catch-all: serve index.html for SPA ---
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`  全市学校供餐管理系统 - 第一阶段`);
    console.log(`  本地访问地址: http://localhost:${PORT}`);
    console.log(`========================================`);
    console.log(`\n测试账号：`);
    console.log(`  市级管理员: admin / 123456`);
    console.log(`  学校用户:   school001 / 123456`);
    console.log(`  食材供应商: supplier001 / 123456`);
    console.log(`  校外供餐:   catering001 / 123456`);
    console.log(`\n  注意：首次登录后请修改密码！`);
    console.log(`========================================\n`);
});
