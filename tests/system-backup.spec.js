const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'server', 'data');
const BACKUPS_DIR = path.join(__dirname, '..', 'server', 'backups');
const SYSTEM_CONFIG_PATH = path.join(DATA_DIR, 'systemConfig.json');

async function login(request, username, password, role) {
  const res = await request.post('/api/auth/login', {
    data: { username, password, role }
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return body.token;
}

async function loginAsAdmin(request) {
  return login(request, 'admin', '123456', 'admin');
}

async function loginAdminPage(page) {
  await page.goto('/');
  await page.fill('input[type="text"]', 'admin');
  await page.fill('input[type="password"]', '123456');
  await page.click('button[type="submit"].btn-login');
  await page.waitForSelector('.sidebar', { timeout: 15000 });
}

async function downloadBackup(request, token) {
  const res = await request.get('/api/system/backup', {
    headers: { Authorization: `Bearer ${token}` }
  });
  expect(res.status()).toBe(200);
  return res.json();
}

function sha256(content, encoding = 'utf8') {
  return crypto.createHash('sha256').update(Buffer.from(content, encoding)).digest('hex');
}

function makeBackup(files) {
  return {
    format: 'school-meal-management-backup',
    version: 1,
    createdAt: new Date().toISOString(),
    source: { app: 'school-meal-management-phase1' },
    files
  };
}

function makeSystemConfigBackup(content) {
  return makeBackup([{
    root: 'data',
    path: 'systemConfig.json',
    encoding: 'utf8',
    size: Buffer.byteLength(content, 'utf8'),
    sha256: sha256(content),
    content
  }]);
}

async function restoreBackup(request, token, backup) {
  return request.post('/api/system/restore', {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      file: {
        name: 'backup.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(backup), 'utf8')
      }
    }
  });
}

test.describe('system backup and restore', () => {
  let originalConfig;

  test.beforeAll(() => {
    originalConfig = fs.readFileSync(SYSTEM_CONFIG_PATH, 'utf8');
  });

  test.afterEach(() => {
    fs.writeFileSync(SYSTEM_CONFIG_PATH, originalConfig);
  });

  test('admin can export a full backup with data files and uploaded files', async ({ request }) => {
    const token = await loginAsAdmin(request);

    const backup = await downloadBackup(request, token);

    expect(backup.format).toBe('school-meal-management-backup');
    expect(backup.version).toBe(1);
    expect(backup.source).toEqual({ app: 'school-meal-management-phase1' });
    expect(new Date(backup.createdAt).toString()).not.toBe('Invalid Date');
    expect(Array.isArray(backup.files)).toBeTruthy();

    const systemConfig = backup.files.find(file => file.root === 'data' && file.path === 'systemConfig.json');
    expect(systemConfig).toBeTruthy();
    expect(systemConfig.encoding).toBe('utf8');
    expect(JSON.parse(systemConfig.content).currentAcademicYear).toBeTruthy();
    expect(systemConfig.sha256).toBe(sha256(systemConfig.content));
    expect(systemConfig.size).toBe(Buffer.byteLength(systemConfig.content, 'utf8'));

    const uploadFile = backup.files.find(file => file.root === 'uploads' && file.path.startsWith('license-images/'));
    expect(uploadFile).toBeTruthy();
    expect(uploadFile.encoding).toBe('base64');
    expect(uploadFile.sha256).toBe(sha256(uploadFile.content, 'base64'));
  });

  test('non-admin users cannot export or restore backups', async ({ request }) => {
    const token = await login(request, 'school101', '123456', 'school');
    const backup = makeSystemConfigBackup(originalConfig);

    const exportRes = await request.get('/api/system/backup', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const restoreRes = await restoreBackup(request, token, backup);

    expect(exportRes.status()).toBe(403);
    expect(restoreRes.status()).toBe(403);
  });

  test('restore rejects tampered hashes without changing data', async ({ request }) => {
    const token = await loginAsAdmin(request);
    const changedConfig = JSON.stringify({ ...JSON.parse(originalConfig), currentAcademicYear: '2099-2100' }, null, 2);
    const backup = makeSystemConfigBackup(changedConfig);
    backup.files[0].sha256 = 'bad-hash';

    const res = await restoreBackup(request, token, backup);

    expect(res.status()).toBe(400);
    expect(fs.readFileSync(SYSTEM_CONFIG_PATH, 'utf8')).toBe(originalConfig);
  });

  test('restore rejects path traversal without changing data', async ({ request }) => {
    const token = await loginAsAdmin(request);
    const content = '{"unsafe":true}';
    const backup = makeBackup([{
      root: 'data',
      path: '../index.js',
      encoding: 'utf8',
      size: Buffer.byteLength(content, 'utf8'),
      sha256: sha256(content),
      content
    }]);

    const res = await restoreBackup(request, token, backup);

    expect(res.status()).toBe(400);
    expect(fs.readFileSync(SYSTEM_CONFIG_PATH, 'utf8')).toBe(originalConfig);
  });

  test('admin can restore a valid backup and a pre-restore backup is created', async ({ request }) => {
    const token = await loginAsAdmin(request);
    const before = fs.existsSync(BACKUPS_DIR)
      ? new Set(fs.readdirSync(BACKUPS_DIR).filter(name => name.startsWith('pre-restore-')))
      : new Set();
    const changedConfig = JSON.stringify({
      ...JSON.parse(originalConfig),
      currentAcademicYear: '2099-2100',
      restoredByTest: true
    }, null, 2);
    const backup = makeSystemConfigBackup(changedConfig);

    const res = await restoreBackup(request, token, backup);

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.restoredFiles).toBe(1);
    expect(body.preRestoreBackup).toContain('pre-restore-');
    expect(JSON.parse(fs.readFileSync(SYSTEM_CONFIG_PATH, 'utf8')).currentAcademicYear).toBe('2099-2100');

    const after = fs.readdirSync(BACKUPS_DIR).filter(name => name.startsWith('pre-restore-'));
    expect(after.some(name => !before.has(name))).toBeTruthy();
  });

  test('admin can open the data backup page from the system menu', async ({ page }) => {
    await loginAdminPage(page);

    await page.click('.nav-item:has-text("数据备份")');

    await expect(page.locator('.page-title')).toHaveText('数据备份');
    await expect(page.locator('button:has-text("导出完整备份")')).toBeVisible();
    await expect(page.locator('button:has-text("覆盖恢复")')).toBeVisible();
    await expect(page.locator('input[placeholder="请输入：覆盖恢复"]')).toBeVisible();
  });
});
