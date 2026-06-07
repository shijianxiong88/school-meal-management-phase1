# 企业证照新增功能实现计划

> **给执行代理的要求：** 实施本计划时必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。每个任务使用复选框跟踪进度。

**目标：** 将企业证照新增功能重做为“上传原件优先”的三步式流程，仅支持营业执照和食品经营许可证。

**架构：** 保留当前 Express + JSON 文件存储 + 单文件 React 前端的项目形态。后端先抽出企业证照规则模块，负责校验、版本化、证照类型识别和预警判断；再把规则接入现有接口。前端替换原来的新增弹窗，改成上传、识别核对、确认保存三步式向导。

**技术栈：** Node.js、Express、React（浏览器 Babel）、multer、JSON 文件存储、Playwright、Node 内置测试运行器。

---

## 文件结构

- 新建 `server/enterpriseLicenseRules.js`：企业证照纯规则函数，包括证照类型规范化、OCR 文本类型判断、表单校验、版本替换、预警状态计算。
- 修改 `server/index.js`：把规则接入企业证照列表、新增、上传、OCR、作废和预警接口。
- 新建 `tests/enterpriseLicenseRules.test.js`：后端规则测试，不依赖启动服务。
- 修改 `public/index.html`：把 `EnterpriseLicenseModal` 替换为三步式 `EnterpriseLicenseCreateWizard`。
- 新建 `tests/enterprise-license-wizard.spec.js`：Playwright 测试新增向导，OCR 接口使用 mock。
- 仅当实现发现规格必须调整时，才修改 `docs/superpowers/specs/2026-06-07-enterprise-license-create-design.md`。

## 任务 1：抽出企业证照规则模块

**文件：**

- 新建：`server/enterpriseLicenseRules.js`
- 新建：`tests/enterpriseLicenseRules.test.js`

- [ ] **步骤 1：先写失败测试**

创建 `tests/enterpriseLicenseRules.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LICENSE_TYPES,
  detectLicenseTypeFromText,
  validateEnterpriseLicenseInput,
  applyLicenseVersioning,
  getLicenseWarningStatus
} = require('../server/enterpriseLicenseRules');

test('营业执照关键词可识别为营业执照', () => {
  const result = detectLicenseTypeFromText('营业执照 统一社会信用代码 91350582MA2YD5WT74');
  assert.equal(result.suggestedType, LICENSE_TYPES.BUSINESS);
  assert.equal(result.confidence, 'high');
});

test('食品经营许可证关键词可识别为食品经营许可证', () => {
  const result = detectLicenseTypeFromText('食品经营许可证 许可证编号 JY23505820887570 主体业态');
  assert.equal(result.suggestedType, LICENSE_TYPES.FOOD);
  assert.equal(result.confidence, 'high');
});

test('不支持的证照类型会被拒绝', () => {
  const result = validateEnterpriseLicenseInput({ type: 'ISO认证体系证书' }, { enterpriseName: '泉州测试企业' });
  assert.equal(result.valid, false);
  assert.match(result.errors.type, /仅支持/);
});

test('食品经营许可证必须填写有效期止', () => {
  const result = validateEnterpriseLicenseInput({
    type: LICENSE_TYPES.FOOD,
    licenseNo: 'JY23505820887570',
    enterpriseName: '泉州测试企业',
    legalPerson: '张三',
    address: '泉州市丰泽区',
    subjectType: '餐饮服务经营者',
    businessScope: '热食类食品制售',
    imageUrl: '/uploads/license-images/a.png'
  }, { enterpriseName: '泉州测试企业' });

  assert.equal(result.valid, false);
  assert.match(result.errors.validUntil, /必填/);
});

test('长期有效营业执照可以不填写有效期止', () => {
  const result = validateEnterpriseLicenseInput({
    type: LICENSE_TYPES.BUSINESS,
    licenseNo: '91350582MA2YD5WT74',
    enterpriseName: '泉州测试企业',
    legalPerson: '张三',
    address: '泉州市丰泽区',
    isLongTerm: true,
    imageUrl: '/uploads/license-images/a.png'
  }, { enterpriseName: '泉州测试企业' });

  assert.equal(result.valid, true);
});

test('新增同企业同类型证照时旧当前版本转历史版本', () => {
  const existing = [{
    id: 'old',
    enterpriseId: 'ent_1',
    type: LICENSE_TYPES.BUSINESS,
    status: 'current',
    version: 1
  }];
  const next = {
    id: 'new',
    enterpriseId: 'ent_1',
    type: LICENSE_TYPES.BUSINESS
  };

  const result = applyLicenseVersioning(existing, next, '2026-06-07T00:00:00.000Z');

  assert.equal(result.licenses.length, 2);
  assert.equal(result.licenses.find(l => l.id === 'old').status, 'history');
  assert.equal(result.licenses.find(l => l.id === 'old').replacedBy, 'new');
  assert.equal(result.licenses.find(l => l.id === 'new').status, 'current');
  assert.equal(result.licenses.find(l => l.id === 'new').version, 2);
  assert.deepEqual(result.replacedIds, ['old']);
});

test('历史版本和长期有效证照不进入普通到期预警', () => {
  assert.equal(getLicenseWarningStatus({ status: 'history', validUntil: '2026-06-08' }, new Date('2026-06-07')), 'none');
  assert.equal(getLicenseWarningStatus({ status: 'current', isLongTerm: true }, new Date('2026-06-07')), 'long-term');
});
```

- [ ] **步骤 2：运行测试，确认失败原因正确**

运行：

```powershell
node --test tests\enterpriseLicenseRules.test.js
```

预期：失败，提示找不到 `../server/enterpriseLicenseRules`。

- [ ] **步骤 3：实现规则模块**

创建 `server/enterpriseLicenseRules.js`，至少导出这些函数和常量：

```js
const LICENSE_TYPES = {
  BUSINESS: '营业执照',
  FOOD: '食品经营许可证'
};

const LICENSE_STATUSES = {
  CURRENT: 'current',
  HISTORY: 'history',
  VOIDED: 'voided'
};

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeLicenseType(type) {
  const text = normalizeText(type);
  if (text.includes('食品经营')) return LICENSE_TYPES.FOOD;
  if (text.includes('营业执照')) return LICENSE_TYPES.BUSINESS;
  return text;
}

function detectLicenseTypeFromText(text) {
  const raw = normalizeText(text);
  const businessHits = ['营业执照', '统一社会信用代码', '法定代表人', '经营范围'].filter(k => raw.includes(k)).length;
  const foodHits = ['食品经营许可证', '许可证编号', '主体业态', '经营项目'].filter(k => raw.includes(k)).length;

  if (foodHits > businessHits && foodHits >= 2) {
    return { suggestedType: LICENSE_TYPES.FOOD, confidence: foodHits >= 3 ? 'high' : 'medium' };
  }
  if (businessHits > foodHits && businessHits >= 2) {
    return { suggestedType: LICENSE_TYPES.BUSINESS, confidence: businessHits >= 3 ? 'high' : 'medium' };
  }
  return { suggestedType: '', confidence: 'low' };
}

function normalizeEnterpriseLicenseInput(input) {
  const normalized = {
    ...input,
    type: normalizeLicenseType(input.type),
    licenseNo: normalizeText(input.licenseNo),
    enterpriseName: normalizeText(input.enterpriseName || input.name),
    legalPerson: normalizeText(input.legalPerson),
    address: normalizeText(input.address || input.businessAddress),
    validFrom: normalizeText(input.validFrom),
    validUntil: normalizeText(input.validUntil),
    issueAuthority: normalizeText(input.issueAuthority),
    issueDate: normalizeText(input.issueDate),
    businessScope: normalizeText(input.businessScope),
    subjectType: normalizeText(input.subjectType),
    supervisionAgency: normalizeText(input.supervisionAgency),
    imageUrl: normalizeText(input.imageUrl),
    isLongTerm: Boolean(input.isLongTerm)
  };
  normalized.name = normalized.enterpriseName;
  return normalized;
}

function isDateOrderInvalid(start, end) {
  if (!start || !end) return false;
  return new Date(end).getTime() < new Date(start).getTime();
}

function validateEnterpriseLicenseInput(input, enterprise) {
  const data = normalizeEnterpriseLicenseInput(input || {});
  const errors = {};
  const warnings = {};

  if (![LICENSE_TYPES.BUSINESS, LICENSE_TYPES.FOOD].includes(data.type)) {
    errors.type = '证照类型仅支持营业执照、食品经营许可证';
  }
  if (!data.imageUrl) errors.imageUrl = '证照文件必填';
  if (!data.licenseNo) errors.licenseNo = '证照编号必填';
  if (!data.enterpriseName) errors.enterpriseName = '企业名称必填';
  if (!data.legalPerson) errors.legalPerson = '法定代表人/负责人必填';
  if (!data.address) errors.address = '住所/经营场所必填';

  if (data.type === LICENSE_TYPES.FOOD) {
    if (!data.validUntil) errors.validUntil = '食品经营许可证有效期止必填';
    if (!data.subjectType) errors.subjectType = '主体业态必填';
    if (!data.businessScope) errors.businessScope = '经营项目必填';
  }

  if (data.type === LICENSE_TYPES.BUSINESS && !data.isLongTerm && isDateOrderInvalid(data.validFrom, data.validUntil)) {
    errors.validUntil = '有效期止不得早于有效期起';
  }
  if (data.type === LICENSE_TYPES.FOOD && isDateOrderInvalid(data.validFrom, data.validUntil)) {
    errors.validUntil = '有效期止不得早于有效期起';
  }

  if (enterprise?.enterpriseName && data.enterpriseName && enterprise.enterpriseName !== data.enterpriseName) {
    warnings.enterpriseName = '证照企业名称与企业档案名称不一致';
  }

  return { valid: Object.keys(errors).length === 0, errors, warnings, data };
}

function applyLicenseVersioning(existingLicenses, nextLicense, nowIso) {
  const currentSameType = existingLicenses.filter(l =>
    l.enterpriseId === nextLicense.enterpriseId &&
    normalizeLicenseType(l.type) === normalizeLicenseType(nextLicense.type) &&
    (l.status || LICENSE_STATUSES.CURRENT) === LICENSE_STATUSES.CURRENT
  );
  const maxVersion = existingLicenses
    .filter(l => l.enterpriseId === nextLicense.enterpriseId && normalizeLicenseType(l.type) === normalizeLicenseType(nextLicense.type))
    .reduce((max, l) => Math.max(max, Number(l.version || 1)), 0);

  const preparedNext = {
    ...nextLicense,
    type: normalizeLicenseType(nextLicense.type),
    status: LICENSE_STATUSES.CURRENT,
    version: maxVersion + 1
  };

  const licenses = existingLicenses.map(l => {
    if (!currentSameType.some(old => old.id === l.id)) return l;
    return {
      ...l,
      status: LICENSE_STATUSES.HISTORY,
      replacedBy: preparedNext.id,
      replacedAt: nowIso,
      updatedAt: nowIso
    };
  });

  licenses.push(preparedNext);
  return { licenses, replacedIds: currentSameType.map(l => l.id), license: preparedNext };
}

function getLicenseWarningStatus(license, now = new Date()) {
  if (!license || (license.status && license.status !== LICENSE_STATUSES.CURRENT)) return 'none';
  if (license.isLongTerm) return 'long-term';
  if (!license.validUntil) return 'unknown';

  const end = new Date(`${license.validUntil}T23:59:59`);
  if (Number.isNaN(end.getTime())) return 'unknown';
  const days = Math.ceil((end.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
  if (days <= 7) return 'red';
  if (days <= 30) return 'yellow';
  return 'green';
}

module.exports = {
  LICENSE_TYPES,
  LICENSE_STATUSES,
  normalizeLicenseType,
  normalizeEnterpriseLicenseInput,
  detectLicenseTypeFromText,
  validateEnterpriseLicenseInput,
  applyLicenseVersioning,
  getLicenseWarningStatus
};
```

- [ ] **步骤 4：运行规则测试**

运行：

```powershell
node --test tests\enterpriseLicenseRules.test.js
```

预期：7 条测试全部通过。

- [ ] **步骤 5：提交任务 1**

运行：

```powershell
git add server\enterpriseLicenseRules.js tests\enterpriseLicenseRules.test.js
git commit -m "test: cover enterprise license rules"
```

## 任务 2：接入后端校验、版本化、上传限制和作废语义

**文件：**

- 修改：`server/index.js`
- 修改：`tests/enterpriseLicenseRules.test.js`

- [ ] **步骤 1：补充版本替换测试**

向 `tests/enterpriseLicenseRules.test.js` 追加：

```js
test('版本化只替换同企业同类型的当前证照', () => {
  const existing = [
    { id: 'same_type_current', enterpriseId: 'ent_1', type: LICENSE_TYPES.FOOD, status: 'current', version: 1 },
    { id: 'other_type_current', enterpriseId: 'ent_1', type: LICENSE_TYPES.BUSINESS, status: 'current', version: 1 },
    { id: 'other_enterprise_current', enterpriseId: 'ent_2', type: LICENSE_TYPES.FOOD, status: 'current', version: 1 }
  ];
  const result = applyLicenseVersioning(existing, { id: 'new_food', enterpriseId: 'ent_1', type: LICENSE_TYPES.FOOD }, '2026-06-07T00:00:00.000Z');

  assert.equal(result.licenses.find(l => l.id === 'same_type_current').status, 'history');
  assert.equal(result.licenses.find(l => l.id === 'other_type_current').status, 'current');
  assert.equal(result.licenses.find(l => l.id === 'other_enterprise_current').status, 'current');
  assert.equal(result.license.version, 2);
});
```

- [ ] **步骤 2：运行规则测试**

```powershell
node --test tests\enterpriseLicenseRules.test.js
```

预期：通过。

- [ ] **步骤 3：在 `server/index.js` 引入规则模块**

在现有 `require` 区域加入：

```js
const {
    LICENSE_TYPES,
    LICENSE_STATUSES,
    normalizeLicenseType,
    normalizeEnterpriseLicenseInput,
    detectLicenseTypeFromText,
    validateEnterpriseLicenseInput,
    applyLicenseVersioning,
    getLicenseWarningStatus
} = require('./enterpriseLicenseRules');
```

- [ ] **步骤 4：新增当前企业解析函数**

放在企业证照接口之前：

```js
function resolveUserEnterprise(user) {
    const roleTypeMap = {
        ingredientSupplier: '食材供应商',
        cateringCompany: '校外供餐企业',
        operationSupplier: '委托经营供应商',
        serviceSupplier: '委托服务提供商'
    };
    const sourceMap = {
        ingredientSupplier: 'ingredientSuppliers.json',
        cateringCompany: 'cateringCompanies.json',
        operationSupplier: 'operationSuppliers.json',
        serviceSupplier: 'serviceSuppliers.json'
    };

    let enterpriseId = user.id;
    let enterpriseName = user.name || '';
    const enterpriseType = roleTypeMap[user.role] || '企业';
    const sourceFile = sourceMap[user.role];

    if (sourceFile) {
        const list = readJSON(sourceFile);
        const record = list.find(item => item.userId === user.id) || list.find(item => item.name === user.name);
        if (record) {
            enterpriseId = record.id;
            enterpriseName = record.name;
        }
    }

    return { enterpriseId, enterpriseName, enterpriseType };
}
```

- [ ] **步骤 5：调整上传限制**

把 multer 限制从 5MB 改成 10MB：

```js
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
```

证照上传只允许：

```js
const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
```

上传成功返回：

```js
res.json({ url: fileUrl, filename, mimeType: req.file.mimetype, size: req.file.size });
```

- [ ] **步骤 6：改造 `POST /api/enterprise-licenses`**

后端必须负责校验和版本化，不能依赖前端处理旧版本。保存逻辑要求：

- 根据登录用户解析企业。
- 规范化证照类型和字段。
- 校验证照文件、证照编号、企业名称、负责人、地址、食品经营许可证有效期止、主体业态、经营项目。
- 同企业同类型同编号重复时返回 409，要求前端确认。
- 确认后新证照保存为 `current`，旧同类型当前证照转 `history`。

返回结构：

```js
res.json({ license: versioned.license, replacedIds: versioned.replacedIds, warnings: validation.warnings });
```

- [ ] **步骤 7：改造列表和删除**

列表接口：

- 普通企业用户只看本企业证照。
- 管理员可看全部。
- 排序时当前版本在前，历史和作废在后。

删除接口不再物理删除，改为作废：

```js
{
  status: LICENSE_STATUSES.VOIDED,
  voidedAt: now,
  voidReason: req.body?.reason || '用户作废',
  updatedAt: now
}
```

- [ ] **步骤 8：运行后端检查**

```powershell
node --test tests\enterpriseLicenseRules.test.js
node -c server\index.js
```

预期：测试通过，语法检查无错误。

- [ ] **步骤 9：提交任务 2**

```powershell
git add server\index.js server\enterpriseLicenseRules.js tests\enterpriseLicenseRules.test.js
git commit -m "feat: version enterprise licenses on create"
```

## 任务 3：新增统一 OCR 入口

**文件：**

- 修改：`server/index.js`
- 修改：`tests/enterpriseLicenseRules.test.js`

- [ ] **步骤 1：补充模糊文本识别测试**

```js
test('模糊文本返回低置信度且不建议类型', () => {
  const result = detectLicenseTypeFromText('泉州市测试企业 法定代表人 张三');
  assert.equal(result.suggestedType, '');
  assert.equal(result.confidence, 'low');
});
```

- [ ] **步骤 2：运行规则测试**

```powershell
node --test tests\enterpriseLicenseRules.test.js
```

- [ ] **步骤 3：抽出 OCR 复用函数**

把现有营业执照 OCR、食品经营许可证 OCR、通用 OCR 的主体逻辑分别抽为：

- `runBusinessLicenseOcr(payload)`
- `runFoodLicenseOcr(payload)`
- `runGeneralOcr(payload)`

现有 `/api/ocr/business-license`、`/api/ocr/food-license`、`/api/ocr/general` 继续保留，只改为调用这些函数。

- [ ] **步骤 4：新增 `POST /api/enterprise-licenses/ocr`**

请求：

```json
{
  "imageUrl": "/uploads/license-images/license_xxx.png",
  "preferredType": "营业执照"
}
```

返回：

```json
{
  "suggestedType": "营业执照",
  "confidence": "medium",
  "fields": {
    "licenseNo": "9135...",
    "enterpriseName": "某某公司"
  },
  "recognizedText": "..."
}
```

行为：

- 如果 `preferredType` 是食品经营许可证，直接走食品经营许可证识别。
- 如果 `preferredType` 是营业执照，直接走营业执照识别。
- 如果没有 `preferredType`，先走通用 OCR 判断类型，再调用对应识别。
- 识别失败时返回错误，前端进入手工录入。

- [ ] **步骤 5：运行检查**

```powershell
node -c server\index.js
node --test tests\enterpriseLicenseRules.test.js
```

- [ ] **步骤 6：提交任务 3**

```powershell
git add server\index.js tests\enterpriseLicenseRules.test.js
git commit -m "feat: add unified enterprise license ocr endpoint"
```

## 任务 4：前端替换为三步式新增向导

**文件：**

- 修改：`public/index.html`

- [ ] **步骤 1：新增向导样式**

在现有弹窗样式附近加入：

```css
.license-wizard { max-width: 1080px; }
.license-stepper { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 20px; }
.license-step { display: flex; align-items: center; gap: 10px; padding: 12px; border-radius: 8px; background: #f8f9fa; color: #777; font-size: 13px; }
.license-step.active { background: #e8f0fe; color: #667eea; font-weight: 600; }
.license-step.done { background: #e8f8f0; color: #27ae60; }
.license-step-num { width: 24px; height: 24px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: #ddd; color: white; font-weight: 700; }
.license-step.active .license-step-num { background: #667eea; }
.license-step.done .license-step-num { background: #27ae60; }
.license-review-layout { display: grid; grid-template-columns: minmax(280px, 42%) 1fr; gap: 20px; align-items: start; }
.license-preview-pane { border: 1px solid #e8ecf0; border-radius: 8px; min-height: 360px; display: flex; align-items: center; justify-content: center; background: #f8f9fa; overflow: hidden; }
.license-preview-pane img { max-width: 100%; max-height: 520px; object-fit: contain; }
.license-field-meta { margin-top: 4px; font-size: 12px; color: #888; }
.license-field-meta.recognized { color: #27ae60; }
.license-field-meta.required { color: #e74c3c; }
.license-field-meta.modified { color: #667eea; }
.license-summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.license-summary-item { padding: 12px; background: #f8f9fa; border-radius: 8px; }
.license-summary-label { color: #888; font-size: 12px; margin-bottom: 4px; }
.license-summary-value { color: #333; font-size: 14px; font-weight: 500; }
@media (max-width: 900px) {
  .license-review-layout { grid-template-columns: 1fr; }
  .license-summary { grid-template-columns: 1fr; }
}
```

- [ ] **步骤 2：替换原 `EnterpriseLicenseModal`**

用 `EnterpriseLicenseCreateWizard` 替换原新增弹窗。组件状态包括：

```js
const [step, setStep] = useState(1);
const [fileInfo, setFileInfo] = useState(null);
const [previewUrl, setPreviewUrl] = useState('');
const [suggestedType, setSuggestedType] = useState('');
const [fieldSources, setFieldSources] = useState({});
const [modifiedFields, setModifiedFields] = useState({});
const [recognizedText, setRecognizedText] = useState('');
const [ocring, setOcring] = useState(false);
const [uploading, setUploading] = useState(false);
const [toast, setToast] = useState(null);
const [form, setForm] = useState({
  type: '',
  licenseNo: '',
  enterpriseName: user?.name || '',
  legalPerson: '',
  address: '',
  validFrom: '',
  validUntil: '',
  isLongTerm: false,
  issueAuthority: '',
  issueDate: '',
  businessScope: '',
  establishDate: '',
  registeredCapital: '',
  subjectType: '',
  supervisionAgency: '',
  imageUrl: ''
});
```

上传步骤：

- 先上传到 `/api/enterprise-licenses/upload`。
- 保存 `imageUrl`。
- 图片文件显示本地预览。
- 上传成功后调用 `/api/enterprise-licenses/ocr`。
- OCR 成功则进入核对页并填充字段。
- OCR 失败也进入核对页，让用户手工补齐。

- [ ] **步骤 3：实现字段状态提示**

字段旁显示：

- `已识别`：OCR 填入且用户未修改。
- `需补充`：必填但为空。
- `已修改`：用户手动改过。

推荐 helper：

```js
const setField = (key, value) => {
  setForm(f => ({ ...f, [key]: value }));
  setModifiedFields(m => ({ ...m, [key]: true }));
};

const fieldMeta = (key, required) => {
  if (modifiedFields[key]) return <div className="license-field-meta modified">已修改</div>;
  if (fieldSources[key] === 'ocr' && form[key]) return <div className="license-field-meta recognized">已识别</div>;
  if (required && !form[key]) return <div className="license-field-meta required">需补充</div>;
  return null;
};
```

- [ ] **步骤 4：实现两类证照字段**

共用字段：

- 证照类型
- 证照编号
- 企业名称
- 法定代表人/负责人
- 住所/经营场所
- 有效期起
- 有效期止
- 发证机关
- 发证日期
- 证照文件

营业执照额外字段：

- 经营范围
- 成立日期
- 注册资本
- 长期有效

食品经营许可证额外字段：

- 主体业态
- 经营项目
- 日常监督管理机构

- [ ] **步骤 5：实现确认保存页**

确认页显示：

- 证照类型
- 证照编号
- 企业名称
- 有效期止或长期有效
- 是否可能替换当前同类型证照

保存时：

- 调用 `POST /api/enterprise-licenses`。
- 如果后端返回 `requiresConfirmation`，弹出重复确认，再带 `confirmDuplicate: true` 保存。
- 保存成功后关闭向导并刷新列表。

- [ ] **步骤 6：运行语法检查**

```powershell
node -c server\index.js
```

前端 JSX 由浏览器 Babel 编译，下一任务用 Playwright 验证。

- [ ] **步骤 7：提交任务 4**

```powershell
git add public\index.html
git commit -m "feat: add enterprise license creation wizard"
```

## 任务 5：新增向导端到端测试

**文件：**

- 新建：`tests/enterprise-license-wizard.spec.js`
- 新建：`tests/fixtures/license-sample.png`

- [ ] **步骤 1：创建测试图片**

运行：

```powershell
New-Item -ItemType Directory -Force -Path tests\fixtures
[Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=') | Set-Content -Encoding Byte tests\fixtures\license-sample.png
```

- [ ] **步骤 2：创建 Playwright 测试**

创建 `tests/enterprise-license-wizard.spec.js`：

```js
const { test, expect } = require('@playwright/test');
const path = require('path');

const BASE_URL = 'http://localhost:3000';

async function loginAsEnterprise(page) {
  await page.goto(BASE_URL);
  await page.waitForSelector('.login-card', { timeout: 15000 });
  await page.click('.role-tab:has-text("企业")');
  await page.fill('input[type="text"]', 'supplier001');
  await page.fill('input[type="password"]', '123456');
  await page.click('button[type="submit"].btn-login');
  await page.waitForSelector('.sidebar', { timeout: 15000 });
}

test('企业证照新增向导先上传原件并填充 OCR 字段', async ({ page }) => {
  await page.route('**/api/enterprise-licenses/upload', async route => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        url: '/uploads/license-images/test-license.png',
        filename: 'test-license.png',
        mimeType: 'image/png',
        size: 1024
      })
    });
  });

  await page.route('**/api/enterprise-licenses/ocr', async route => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        suggestedType: '营业执照',
        confidence: 'high',
        fields: {
          type: '营业执照',
          enterpriseName: '测试食材供应商01',
          licenseNo: '91350582MA2YD5WT74',
          legalPerson: '张三',
          address: '泉州市丰泽区测试路1号',
          businessScope: '餐饮管理；食品销售',
          isLongTerm: true
        },
        recognizedText: '营业执照\n统一社会信用代码 91350582MA2YD5WT74'
      })
    });
  });

  await loginAsEnterprise(page);
  await page.click('.nav-item:has-text("证照管理")');
  await page.click('.btn-primary:has-text("新增证照")');

  await expect(page.locator('.license-step.active')).toContainText('上传原件');

  const filePath = path.join(__dirname, 'fixtures', 'license-sample.png');
  await page.setInputFiles('input[type="file"]', filePath);

  await expect(page.locator('.license-step.active')).toContainText('识别核对');
  await expect(page.locator('input[value="91350582MA2YD5WT74"]')).toBeVisible();
  await expect(page.locator('.license-field-meta.recognized').first()).toBeVisible();
});
```

- [ ] **步骤 3：运行测试**

启动服务：

```powershell
npm run dev
```

另一个终端运行：

```powershell
npx playwright test tests\enterprise-license-wizard.spec.js
```

预期：通过。若因为现有页面中文显示乱码导致文本选择器失败，改用任务 4 中新增的稳定 CSS 类选择器。

- [ ] **步骤 4：提交任务 5**

```powershell
git add tests\enterprise-license-wizard.spec.js tests\fixtures\license-sample.png
git commit -m "test: cover enterprise license creation wizard"
```

## 任务 6：更新列表和预警语义

**文件：**

- 修改：`server/index.js`
- 修改：`public/index.html`
- 修改：`tests/enterpriseLicenseRules.test.js`

- [ ] **步骤 1：补充预警测试**

```js
test('当前证照按有效期返回红黄绿预警', () => {
  const now = new Date('2026-06-07T00:00:00');
  assert.equal(getLicenseWarningStatus({ status: 'current', validUntil: '2026-06-07' }, now), 'red');
  assert.equal(getLicenseWarningStatus({ status: 'current', validUntil: '2026-06-20' }, now), 'yellow');
  assert.equal(getLicenseWarningStatus({ status: 'current', validUntil: '2026-08-01' }, now), 'green');
});
```

- [ ] **步骤 2：后端预警只统计当前版本**

在 `server/index.js` 的预警统计逻辑中：

```js
const currentLicenses = licenses.filter(l => (l.status || LICENSE_STATUSES.CURRENT) === LICENSE_STATUSES.CURRENT);
```

只统计 `getLicenseWarningStatus(license)` 返回的 `red` 和 `yellow`。

忽略：

- `history`
- `voided`
- `none`
- `long-term`

- [ ] **步骤 3：前端列表默认显示当前版本**

在 `EnterpriseLicensesPage` 中：

```js
const visibleLicenses = licenses.filter(l => (l.status || 'current') === 'current');
```

新增“版本状态”列：

```jsx
<td>{(c.status || 'current') === 'current' ? `当前版本 v${c.version || 1}` : `历史版本 v${c.version || 1}`}</td>
```

删除操作文案改为作废：

```js
if (!confirm('确认作废该证照？作废后不会进入预警统计。')) return;
```

- [ ] **步骤 4：运行验证**

```powershell
node --test tests\enterpriseLicenseRules.test.js
node -c server\index.js
npx playwright test tests\enterprise-license-wizard.spec.js
```

- [ ] **步骤 5：提交任务 6**

```powershell
git add server\index.js public\index.html tests\enterpriseLicenseRules.test.js
git commit -m "feat: limit license warnings to current versions"
```

## 任务 7：最终验证和收尾

**文件：**

- 检查：`server/index.js`
- 检查：`public/index.html`
- 检查：`server/enterpriseLicenseRules.js`
- 检查：`tests/enterpriseLicenseRules.test.js`
- 检查：`tests/enterprise-license-wizard.spec.js`

- [ ] **步骤 1：运行目标验证**

```powershell
node --test tests\enterpriseLicenseRules.test.js
node -c server\index.js
npx playwright test tests\enterprise-license-wizard.spec.js
```

预期：全部通过。

- [ ] **步骤 2：运行既有冒烟测试**

```powershell
npx playwright test tests\phase1.spec.js
```

预期：通过。若失败，记录具体失败用例和错误，并判断是本次改动造成还是既有乱码选择器问题。

- [ ] **步骤 3：检查改动范围**

```powershell
git status --short
git diff --stat HEAD
```

预期：只包含企业证照新增功能、规则模块和相关测试。

- [ ] **步骤 4：如有收尾改动则提交**

```powershell
git add server\index.js public\index.html server\enterpriseLicenseRules.js tests\enterpriseLicenseRules.test.js tests\enterprise-license-wizard.spec.js tests\fixtures\license-sample.png
git commit -m "chore: polish enterprise license creation flow"
```

如果没有收尾改动，不创建空提交。
