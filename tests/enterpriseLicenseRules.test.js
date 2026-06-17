const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LICENSE_TYPES,
  detectLicenseTypeFromText,
  validateEnterpriseLicenseInput,
  applyLicenseVersioning,
  getLicenseWarningStatus,
  currentEnterpriseLicenses,
  buildCredentialRows,
  attachCurrentLicensesToEnterprises,
  applyLicenseToEnterpriseRecord
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

test('食品经营许可证关键词被空格拆开仍可识别', () => {
  const result = detectLicenseTypeFromText('食 品 经 营 许 可 证\\n许 可 证 编 号：JY23505820903397\\n主 体 业 态');
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

test('模糊文本返回低置信度且不建议类型', () => {
  const result = detectLicenseTypeFromText('泉州市测试企业 法定代表人 张三');
  assert.equal(result.suggestedType, '');
  assert.equal(result.confidence, 'low');
});

test('current enterprise licenses are attached to enterprise records', () => {
  const enterprises = [{ id: 'ent_1', name: 'Test Catering', foodLicenseNo: 'OLD-JY' }];
  const licenses = [
    { id: 'old_food', enterpriseId: 'ent_1', type: LICENSE_TYPES.FOOD, licenseNo: 'OLD-JY', status: 'history' },
    {
      id: 'new_food',
      enterpriseId: 'ent_1',
      type: LICENSE_TYPES.FOOD,
      licenseNo: 'JY1234567890',
      validFrom: '2026-01-01',
      validUntil: '2031-01-01',
      businessScope: 'Hot meals',
      address: 'License address',
      imageUrl: '/uploads/license-images/food.jpg',
      status: 'current',
      version: 2
    },
    {
      id: 'business',
      enterpriseId: 'ent_1',
      type: LICENSE_TYPES.BUSINESS,
      licenseNo: '91350582MA2YD5WT74',
      imageUrl: '/uploads/license-images/business.jpg',
      status: 'current'
    }
  ];

  const [enterprise] = attachCurrentLicensesToEnterprises(enterprises, licenses);

  assert.equal(enterprise.foodLicenseNo, 'JY1234567890');
  assert.equal(enterprise.foodLicenseValidFrom, '2026-01-01');
  assert.equal(enterprise.foodLicenseValidUntil, '2031-01-01');
  assert.equal(enterprise.foodLicenseBusinessItems, 'Hot meals');
  assert.equal(enterprise.foodLicenseAddress, 'License address');
  assert.equal(enterprise.foodLicenseImageUrl, '/uploads/license-images/food.jpg');
  assert.equal(enterprise.businessLicenseNo, '91350582MA2YD5WT74');
  assert.equal(enterprise.businessLicenseImageUrl, '/uploads/license-images/business.jpg');
  assert.equal(enterprise.currentLicenses.length, 2);
});

test('saving a current food license updates catering enterprise license summary fields', () => {
  const enterprise = { id: 'ent_1', name: 'Test Catering', foodLicenseNo: 'OLD-JY' };
  const updated = applyLicenseToEnterpriseRecord(enterprise, {
    type: LICENSE_TYPES.FOOD,
    licenseNo: 'JY9999999999',
    validFrom: '2026-02-01',
    validUntil: '2031-02-01',
    businessScope: 'Meal delivery',
    subjectType: 'Catering',
    address: 'New address',
    imageUrl: '/uploads/license-images/new-food.jpg',
    status: 'current'
  });

  assert.equal(updated.foodLicenseNo, 'JY9999999999');
  assert.equal(updated.foodLicenseBusinessType, 'Catering');
  assert.equal(updated.foodLicenseBusinessItems, 'Meal delivery');
  assert.equal(updated.foodLicenseAddress, 'New address');
  assert.equal(updated.foodLicenseImageUrl, '/uploads/license-images/new-food.jpg');
});

test('credential rows include only current enterprise licenses', () => {
  const rows = buildCredentialRows([
    {
      id: 'old_food',
      enterpriseId: 'ent_1',
      enterpriseName: '泉州市松花春水餐饮服务有限公司',
      name: '泉州市松花春水餐饮服务有限公司食品经营许可证',
      type: LICENSE_TYPES.FOOD,
      licenseNo: 'JY23505820887570',
      status: 'history',
      version: 1
    },
    {
      id: 'new_food',
      enterpriseId: 'ent_1',
      enterpriseName: '泉州市松花春水餐饮服务有限公司',
      name: '泉州市松花春水餐饮服务有限公司食品经营许可证',
      type: LICENSE_TYPES.FOOD,
      licenseNo: 'JY23505820937734',
      imageUrl: '/uploads/license-images/new-food.jpg',
      status: 'current',
      version: 2
    }
  ], [{ id: 'school_cert', name: 'School certificate' }]);

  assert.equal(rows.some(r => r.licenseNo === 'JY23505820887570'), false);
  assert.equal(rows.some(r => r.licenseNo === 'JY23505820937734'), true);
  assert.equal(rows.find(r => r.id === 'new_food').imageUrl, '/uploads/license-images/new-food.jpg');
  assert.equal(rows.some(r => r.id === 'school_cert'), true);
});

test('credential rows build a full display name when enterprise license name is only the enterprise name', () => {
  const rows = buildCredentialRows([{
    id: 'food',
    enterpriseId: 'ent_1',
    enterpriseName: 'Acme Catering',
    name: 'Acme Catering',
    type: LICENSE_TYPES.FOOD,
    licenseNo: 'JY1234567890',
    status: 'current'
  }], []);

  assert.equal(rows[0].name, `Acme Catering${LICENSE_TYPES.FOOD}`);
  assert.equal(rows[0].ownerName, 'Acme Catering');
});

test('credential rows do not duplicate license type when name already includes it', () => {
  const rows = buildCredentialRows([{
    id: 'food',
    enterpriseId: 'ent_1',
    enterpriseName: 'Acme Catering',
    name: `Acme Catering${LICENSE_TYPES.FOOD}`,
    type: LICENSE_TYPES.FOOD,
    licenseNo: 'JY1234567890',
    status: 'current'
  }], []);

  assert.equal(rows[0].name, `Acme Catering${LICENSE_TYPES.FOOD}`);
});

test('credential rows keep regular certificates visible and fill missing certificate name', () => {
  const rows = buildCredentialRows([], [{
    id: 'cert',
    ownerName: 'Acme Catering',
    type: 'ISO Certificate'
  }]);

  assert.equal(rows[0].name, 'Acme CateringISO Certificate');
});

test('currentEnterpriseLicenses treats legacy rows without status as current', () => {
  assert.deepEqual(
    currentEnterpriseLicenses([{ id: 'legacy' }, { id: 'old', status: 'history' }]).map(l => l.id),
    ['legacy']
  );
});
