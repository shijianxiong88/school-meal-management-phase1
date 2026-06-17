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
  const compact = raw.replace(/\s+/g, '');
  const hasFoodTitle = compact.includes('食品经营许可证');
  const hasFoodLicenseNo = /JY[0-9A-Z]{8,20}/i.test(compact);
  const businessHits = ['营业执照', '统一社会信用代码', '法定代表人', '经营范围'].filter(k => compact.includes(k)).length;
  const foodHits = ['食品经营许可证', '许可证编号', '主体业态', '经营项目', '经营者名称'].filter(k => compact.includes(k)).length +
    (hasFoodLicenseNo ? 1 : 0);

  if (hasFoodTitle || hasFoodLicenseNo || foodHits >= 2) {
    return { suggestedType: LICENSE_TYPES.FOOD, confidence: foodHits >= 2 || hasFoodTitle ? 'high' : 'medium' };
  }

  if (foodHits > businessHits && foodHits >= 2) {
    return { suggestedType: LICENSE_TYPES.FOOD, confidence: foodHits >= 2 ? 'high' : 'medium' };
  }
  if (businessHits > foodHits && businessHits >= 2) {
    return { suggestedType: LICENSE_TYPES.BUSINESS, confidence: businessHits >= 2 ? 'high' : 'medium' };
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
    establishDate: normalizeText(input.establishDate),
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

function isCurrentLicense(license) {
  return (license?.status || LICENSE_STATUSES.CURRENT) === LICENSE_STATUSES.CURRENT;
}

function currentEnterpriseLicenses(licenses) {
  return (licenses || []).filter(isCurrentLicense);
}

function buildDisplayName(name, ownerName, type) {
  const baseName = normalizeText(name);
  const normalizedOwnerName = normalizeText(ownerName);
  const normalizedType = normalizeText(type);
  if (baseName && (!normalizedType || baseName.includes(normalizedType))) return baseName;
  if (baseName && normalizedType) return `${baseName}${normalizedType}`;
  if (normalizedOwnerName && normalizedType) return `${normalizedOwnerName}${normalizedType}`;
  return baseName || normalizedOwnerName || normalizedType;
}

function toCredentialRow(license) {
  const ownerName = license.enterpriseName || license.ownerName || license.name;
  return {
    id: license.id,
    name: buildDisplayName(license.name, ownerName, license.type),
    ownerId: license.enterpriseId,
    ownerName,
    ownerType: license.enterpriseType || '企业',
    type: license.type,
    licenseNo: license.licenseNo,
    validFrom: license.validFrom,
    validUntil: license.validUntil,
    businessScope: license.businessScope,
    imageUrl: license.imageUrl,
    status: license.status || LICENSE_STATUSES.CURRENT,
    version: license.version || 1,
    createdAt: license.createdAt,
    updatedAt: license.updatedAt,
    _source: 'enterpriseLicense'
  };
}

function buildCredentialRows(enterpriseLicenses, credentials) {
  const convertedLicenses = currentEnterpriseLicenses(enterpriseLicenses).map(toCredentialRow);
  const regularCredentials = (credentials || []).map(credential => ({
    ...credential,
    name: buildDisplayName(credential.name, credential.ownerName, credential.type)
  }));
  return [...convertedLicenses, ...regularCredentials];
}

function applyLicenseToEnterpriseRecord(enterprise, license) {
  if (!enterprise || !license || !isCurrentLicense(license)) return enterprise;

  const type = normalizeLicenseType(license.type);
  if (type === LICENSE_TYPES.FOOD) {
    return {
      ...enterprise,
      foodLicenseNo: license.licenseNo || '',
      foodLicenseBusinessType: license.subjectType || license.foodLicenseBusinessType || '',
      foodLicenseBusinessItems: license.businessScope || license.foodLicenseBusinessItems || '',
      foodLicenseAddress: license.address || license.foodLicenseAddress || '',
      foodLicenseValidFrom: license.validFrom || '',
      foodLicenseValidUntil: license.validUntil || '',
      foodLicenseImageUrl: license.imageUrl || '',
      updatedAt: enterprise.updatedAt
    };
  }

  if (type === LICENSE_TYPES.BUSINESS) {
    return {
      ...enterprise,
      businessLicenseNo: license.licenseNo || '',
      businessLicenseValidFrom: license.validFrom || '',
      businessLicenseValidUntil: license.validUntil || '',
      businessLicenseImageUrl: license.imageUrl || '',
      businessLicenseIssueAuthority: license.issueAuthority || '',
      businessLicenseIssueDate: license.issueDate || '',
      legalPerson: license.legalPerson || enterprise.legalPerson || '',
      address: license.address || enterprise.address || '',
      businessScope: license.businessScope || enterprise.businessScope || '',
      establishDate: license.establishDate || enterprise.establishDate || '',
      capital: license.registeredCapital || enterprise.capital || '',
      updatedAt: enterprise.updatedAt
    };
  }

  return enterprise;
}

function attachCurrentLicensesToEnterprises(enterprises, licenses) {
  const currentByEnterprise = new Map();
  (licenses || []).filter(isCurrentLicense).forEach(license => {
    const enterpriseId = license.enterpriseId;
    if (!enterpriseId) return;
    if (!currentByEnterprise.has(enterpriseId)) currentByEnterprise.set(enterpriseId, []);
    currentByEnterprise.get(enterpriseId).push(license);
  });

  return (enterprises || []).map(enterprise => {
    const currentLicenses = currentByEnterprise.get(enterprise.id) || [];
    return currentLicenses.reduce(
      (record, license) => applyLicenseToEnterpriseRecord(record, license),
      { ...enterprise, currentLicenses }
    );
  });
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
  currentEnterpriseLicenses,
  buildCredentialRows,
  attachCurrentLicensesToEnterprises,
  applyLicenseToEnterpriseRecord,
  getLicenseWarningStatus
};
