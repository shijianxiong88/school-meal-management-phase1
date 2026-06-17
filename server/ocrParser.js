function unwrapValue(value) {
    if (!value) return '';
    if (Array.isArray(value)) return unwrapValue(value[0]);
    if (typeof value === 'object' && value.word !== undefined) return String(value.word || '').trim();
    if (typeof value === 'object' && value.words !== undefined) return String(value.words || '').trim();
    return String(value).trim();
}

function normalizeSpaces(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function compact(text) {
    return String(text || '').replace(/\s+/g, '').trim();
}

const FIELD_LABELS = [
    '经营者名称', '企业名称', '单位名称', '名称',
    '许可证编号', '编号',
    '统一社会信用代码', '社会信用代码', '身份证号码',
    '法定代表人（负责人）', '法定代表人', '法绽代表人（负责人）', '法绽代表人', '负责人', '企业法人',
    '住所', '经营场所', '地址',
    '主体业态', '经营项目', '经营范围', '许可范围',
    '日常监督管理机构', '日常监督管理人员',
    '发证机关', '发证机', '签发人', '签发', '发证日期', '签发日期',
    '有效期自', '有效期起', '有效期至', '有效期止', '有效期',
    '投诉举报电话'
];

function labelPattern(label) {
    return label.split('').map(ch => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
}

function isBlankValue(value) {
    const raw = String(value || '');
    const text = compact(raw);
    return !text ||
        /^[：:，,。.、（）()【】\[\]\-_\s]+$/.test(raw) ||
        /^[（(][^）)]*[）)][:：]?$/.test(text);
}

function isFieldLabel(value) {
    const text = compact(value).replace(/[：:]+$/, '');
    if (!text) return false;
    return FIELD_LABELS.some(label => text === compact(label) || text.endsWith(compact(label)));
}

function lineMatchesLabel(line, labels) {
    const text = compact(line);
    return labels.some(label => {
        const normalized = compact(label);
        if (text === normalized) return true;
        if (!text.startsWith(normalized)) return false;
        const rest = text.slice(normalized.length);
        return !rest || /^[：:（）()\d]/.test(rest);
    });
}

function extractInlineValue(line, labels) {
    const normalized = normalizeSpaces(line);
    for (const label of labels) {
        if (label === '发证机' && compact(normalized).startsWith('发证机关')) continue;
        const re = new RegExp(`^\\s*${labelPattern(label)}\\s*[:：]?\\s*(.+)$`);
        const match = normalized.match(re);
        if (match && match[1] && !isBlankValue(match[1]) && !isFieldLabel(match[1])) {
            return normalizeSpaces(match[1]);
        }
    }
    return '';
}

function extractAfterLabel(lines, labels, options = {}) {
    const reject = options.reject || (() => false);
    for (let i = 0; i < lines.length; i++) {
        const inline = extractInlineValue(lines[i], labels);
        if (inline && !reject(inline)) return inline;

        if (!lineMatchesLabel(lines[i], labels)) continue;

        const maxLookahead = options.maxLookahead || 3;
        for (let j = i + 1; j < lines.length && j <= i + maxLookahead; j++) {
            const candidate = normalizeSpaces(lines[j]);
            if (candidate && !isBlankValue(candidate) && !isFieldLabel(candidate) && !reject(candidate)) return candidate;
        }
    }
    return '';
}

function extractBeforeLabel(lines, labels, options = {}) {
    const reject = options.reject || (() => false);
    const maxLookbehind = options.maxLookbehind || 2;
    for (let i = 0; i < lines.length; i++) {
        if (!lineMatchesLabel(lines[i], labels)) continue;

        for (let j = i - 1; j >= 0 && j >= i - maxLookbehind; j--) {
            const candidate = normalizeSpaces(lines[j]);
            if (candidate && !isBlankValue(candidate) && !isFieldLabel(candidate) && !reject(candidate)) return candidate;
        }
    }
    return '';
}

function normalizeDate(text) {
    if (!text) return '';
    const value = compact(text);
    if (/长期/.test(value)) return '2099-12-31';
    const match = value.match(/(20\d{2}|19\d{2})(?:年|[./-])(\d{1,2})(?:月|[./-])(\d{1,2})日?/);
    if (!match) return '';
    return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}

function extractDateRange(text) {
    const value = String(text || '');
    const dates = extractDates(value);
    return {
        from: dates[0] || '',
        until: /长期/.test(value) ? '2099-12-31' : (dates[1] || '')
    };
}

function extractDates(text) {
    const dates = [];
    const value = compact(text);
    const re = /(20\d{2}|19\d{2})(?:年|[./-])(\d{1,2})(?:月|[./-])(\d{1,2})日?/g;
    let match;
    while ((match = re.exec(value)) !== null) {
        dates.push(`${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`);
    }
    return dates;
}

function extractLooseDateAfterLabel(lines, labels) {
    for (let i = 0; i < lines.length; i++) {
        if (!lineMatchesLabel(lines[i], labels)) continue;

        const windowText = lines.slice(i, i + 14).join(' ');
        const direct = normalizeDate(windowText);
        if (direct) return direct;

        const tokens = windowText.match(/(20\d{2}|19\d{2}|\d{1,2})/g) || [];
        const yearIndex = tokens.findIndex(token => /^(20\d{2}|19\d{2})$/.test(token));
        if (yearIndex === -1) continue;
        const month = tokens.slice(yearIndex + 1).find(token => Number(token) >= 1 && Number(token) <= 12);
        const day = tokens.slice(yearIndex + 1).filter(token => token !== month).find(token => Number(token) >= 1 && Number(token) <= 31);
        if (month && day) return `${tokens[yearIndex]}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    return '';
}

function findLineIndex(lines, value) {
    const target = compact(value);
    if (!target) return -1;
    return lines.findIndex(line => compact(line) === target);
}

function appendNearbyContinuation(lines, value, pattern, maxLookahead = 6) {
    let idx = findLineIndex(lines, value);
    if (idx === -1) {
        const fullValue = compact(value);
        idx = lines.findIndex(line => {
            const lineValue = compact(line);
            return lineValue && fullValue.endsWith(lineValue);
        });
    }
    if (idx === -1) return value;
    for (let i = idx + 1; i < lines.length && i <= idx + maxLookahead; i++) {
        const candidate = normalizeSpaces(lines[i]);
        if (isBlankValue(candidate) || isFieldLabel(candidate)) continue;
        if (pattern.test(compact(candidate))) return `${value}${candidate}`;
    }
    return value;
}

function normalizeIssueAuthority(value) {
    return normalizeSpaces(value)
        .replace(/市场遮督管理局/g, '市场监督管理局')
        .replace(/市场着理局/g, '市场监督管理局')
        .replace(/市场监督管?理局/g, '市场监督管理局');
}

function appendBusinessScopeContinuations(lines, value) {
    let idx = findLineIndex(lines, value);
    if (idx === -1) {
        const fullValue = compact(value);
        idx = lines.findIndex(line => {
            const lineValue = compact(line);
            return lineValue && fullValue.endsWith(lineValue);
        });
    }
    if (idx === -1) return value;

    let result = value;
    for (let i = idx + 1; i < lines.length && i <= idx + 10; i++) {
        const candidate = normalizeSpaces(lines[i]);
        const candidateCompact = compact(candidate);
        if (!candidate || isBlankValue(candidate) || isFieldLabel(candidate)) continue;
        if (/^(签发人|有效期|投诉举报|日常监督|主体业态)/.test(candidateCompact)) break;
        if (!/(预包装|散装|食品销售|冷藏|冷冻|熟食|热食|餐饮服务|含散装|食品制售)/.test(candidateCompact)) continue;
        result += candidate;
    }
    return result;
}

function normalizeBusinessScope(value) {
    return normalizeSpaces(value)
        .replace(/损苞装/g, '预包装');
}

function pickIssueDate(lines, fullText, validFrom, validUntil, structuredDate) {
    const direct = normalizeDate(structuredDate) || structuredDate;
    if (direct) return direct;

    const fromAllText = extractDates(fullText).find(date => date !== validUntil && date !== validFrom);
    if (fromAllText) return fromAllText;

    const loose = extractLooseDateAfterLabel(lines, ['签发人', '签发', '发证日期', '签发日期', '发证机关', '发证机']);
    if (loose && loose !== validUntil) return loose;

    return validFrom && validFrom !== validUntil ? validFrom : '';
}

function linesFromOcr(data) {
    if (!data) return [];
    const wordsResult = data.words_result;
    if (Array.isArray(wordsResult)) return wordsResult.map(item => unwrapValue(item)).filter(Boolean);
    if (wordsResult && typeof wordsResult === 'object') {
        return Object.entries(wordsResult)
            .map(([key, value]) => `${key}: ${unwrapValue(value)}`)
            .filter(line => !line.endsWith(': '));
    }
    return [];
}

function mergeSplitFoodLabels(lines) {
    const merged = [];
    for (let i = 0; i < lines.length; i++) {
        const current = normalizeSpaces(lines[i]);
        const next1 = normalizeSpaces(lines[i + 1] || '');
        const next2 = normalizeSpaces(lines[i + 2] || '');
        const next3 = normalizeSpaces(lines[i + 3] || '');

        if (compact(current) === '经' && compact(next1).startsWith('营者名称')) {
            merged.push(`${current}${next1}`);
            i += 1;
        } else if (compact(current) === '住' && compact(next1).startsWith('所')) {
            merged.push(`${current}${next1}`);
            i += 1;
        } else if (compact(current) === '经' && compact(next1) === '营' && compact(next2) === '场' && compact(next3).startsWith('所')) {
            merged.push(`${current}${next1}${next2}${next3}`);
            i += 3;
        } else if (compact(current) === '主' && compact(next1) === '体' && compact(next2) === '业' && compact(next3).startsWith('态')) {
            merged.push(`${current}${next1}${next2}${next3}`);
            i += 3;
        } else if (compact(current) === '经' && compact(next1) === '营' && compact(next2) === '项' && compact(next3).startsWith('目')) {
            merged.push(`${current}${next1}${next2}${next3}`);
            i += 3;
        } else if (compact(current) === '经营' && compact(next1).startsWith('项目')) {
            merged.push(`${current}${next1}`);
            i += 1;
        } else if (compact(current) === '发证' && compact(next1).startsWith('机关')) {
            merged.push(`${current}${next1}`);
            i += 1;
        } else if (compact(current) === '发证' && compact(next1) === '机') {
            merged.push(`${current}${next1}`);
            i += 1;
        } else if (compact(current) === '签' && compact(next1).startsWith('发') && compact(next2).startsWith('人')) {
            merged.push(`${current}${next1}${next2}`);
            i += 2;
        } else if (compact(current) === '签' && compact(next1) === '发') {
            merged.push(`${current}${next1}`);
            i += 1;
        } else {
            merged.push(current);
        }
    }
    return merged;
}

function getStructured(words, keys) {
    for (const key of keys) {
        if (words && words[key] !== undefined) return unwrapValue(words[key]);
    }
    return '';
}

function cleanLicenseNo(value) {
    return compact(value).replace(/[：:]/g, '').toUpperCase();
}

function parseGeneralOcrForFoodLicense(data) {
    const lines = mergeSplitFoodLabels(linesFromOcr(data));
    const structured = data.words_result && !Array.isArray(data.words_result) ? data.words_result : {};
    const fullText = lines.join('\n');
    const result = {
        name: '',
        licenseNo: '',
        type: '食品经营许可证',
        legalPerson: '',
        address: '',
        validFrom: '',
        validUntil: '',
        issueAuthority: '',
        issueDate: '',
        businessScope: '',
        subjectType: '',
        supervisionAgency: '',
        words_result: data.words_result || []
    };

    const rejectFoodName = value =>
        /许可证|社会信用代码|法定代表人|负责人|住所|经营场所|主体业态|经营项目/.test(value) ||
        /^(JY|[0-9A-Z]{10,})/i.test(compact(value)) ||
        !/[\u4e00-\u9fa5]/.test(value);
    result.name = getStructured(structured, ['经营者名称', '企业名称', '单位名称', '名称']) ||
        extractAfterLabel(lines, ['经营者名称', '企业名称', '单位名称', '名称'], { reject: rejectFoodName }) ||
        extractBeforeLabel(lines, ['经营者名称', '企业名称', '单位名称', '名称'], {
            maxLookbehind: 2,
            reject: value => rejectFoodName(value) || !/(公司|企业|学校|幼儿园|食堂|餐厅|店|中心)/.test(value)
        });

    const licenseInline = getStructured(structured, ['许可证编号', '编号']) ||
        extractAfterLabel(lines, ['许可证编号', '编号']);
    const licenseMatch = compact(licenseInline).match(/JY[0-9A-Z]{10,20}/i) ||
        compact(fullText).match(/JY[0-9A-Z]{10,20}/i);
    if (licenseMatch) result.licenseNo = licenseMatch[0].toUpperCase();

    const creditValue = getStructured(structured, ['统一社会信用代码', '社会信用代码', '身份证号码']) ||
        extractAfterLabel(lines, ['统一社会信用代码', '社会信用代码', '身份证号码']);
    if (!result.licenseNo) {
        const creditMatch = cleanLicenseNo(creditValue || fullText).match(/[0-9A-Z]{18}/);
        if (creditMatch) result.licenseNo = creditMatch[0];
    }

    result.legalPerson = getStructured(structured, ['法定代表人', '负责人', '法定代表人（负责人）', '法绽代表人（负责人）', '法绽代表人', '企业法人']) ||
        extractAfterLabel(lines, ['法定代表人（负责人）', '法定代表人', '法绽代表人（负责人）', '法绽代表人', '负责人', '企业法人'], {
        reject: value => value.length > 12 || /住所|经营|许可证|监督/.test(value)
    }).replace(/^\[N\/A\]/, '');

    result.businessScope = getStructured(structured, ['经营项目', '经营范围', '许可范围']) ||
        extractAfterLabel(lines, ['经营项目', '经营范围', '许可范围'], {
        maxLookahead: 4,
        reject: value => /签发人|有效期|发证机关|监督|^\d+\.|餐配送[)）]?$|^配送[)）]?$/.test(value) || compact(value).length < 4
    });

    result.address = getStructured(structured, ['经营场所', '住所', '地址']) ||
        extractAfterLabel(lines, ['经营场所', '住所', '地址'], {
            maxLookahead: 5,
            reject: value =>
                /主体业态|经营项目|许可证|法定代表人|申请|延续|日前|^\d+\./.test(value) ||
                !/(省|市|县|区|路|街|镇|村|号|楼|层)/.test(value)
        });

    result.subjectType = getStructured(structured, ['主体业态']) ||
        extractBeforeLabel(lines, ['主体业态'], {
            maxLookbehind: 4,
            reject: value => !/(餐饮|食堂|经营者|单位)/.test(value)
        }) ||
        extractAfterLabel(lines, ['主体业态'], {
            maxLookahead: 3,
            reject: value => /经营项目|许可证|有效期|发证机关/.test(value) || compact(value).length < 4
        });
    if (/配$/.test(compact(result.subjectType))) {
        result.subjectType = appendNearbyContinuation(lines, result.subjectType, /^送[)）]?$/);
    }
    if (/用餐$/.test(compact(result.subjectType))) {
        result.subjectType = appendNearbyContinuation(lines, result.subjectType, /^配送[)）]?$/);
    }

    result.supervisionAgency = getStructured(structured, ['日常监督管理机构']) ||
        extractAfterLabel(lines, ['日常监督管理机构'], {
            maxLookahead: 8,
            reject: value => /日常监督管理人|投诉举报|发证机关|^JY|^[0-9A-Z]{10,}$/.test(compact(value))
        });

    result.issueAuthority = getStructured(structured, ['发证机关']) ||
        extractAfterLabel(lines, ['发证机关', '发证机'], {
            maxLookahead: 8,
            reject: value => /签发人|有效期|二维码|食品|热食|预包装|冷藏/.test(value)
        });
    result.issueAuthority = normalizeIssueAuthority(result.issueAuthority);

    const fromText = getStructured(structured, ['有效期自', '有效期起']) ||
        extractAfterLabel(lines, ['有效期自', '有效期起', '自']);
    const untilText = getStructured(structured, ['有效期至', '有效期止']) ||
        extractAfterLabel(lines, ['有效期至', '有效期止', '至']);
    result.validFrom = normalizeDate(fromText);
    result.validUntil = normalizeDate(untilText);

    if (!result.validFrom && !result.validUntil) {
        const range = extractDateRange(getStructured(structured, ['有效期']) || extractAfterLabel(lines, ['有效期', '营业期限']) || fullText);
        if (!result.validFrom) result.validFrom = range.from;
        if (!result.validUntil) result.validUntil = range.until;
    }

    if (!result.validUntil) {
        const validUntilMatch = fullText.match(/有效期\s*至\s*([0-9年月日./-]+)/);
        if (validUntilMatch) result.validUntil = normalizeDate(validUntilMatch[1]);
    }
    if (!result.validUntil) {
        result.validUntil = extractLooseDateAfterLabel(lines, ['有效期至', '有效期止']);
    }

    if (!result.validFrom && result.validUntil) {
        result.validFrom = extractDates(fullText).find(date => date !== result.validUntil) || '';
    }
    result.issueDate = pickIssueDate(
        lines,
        fullText,
        result.validFrom,
        result.validUntil,
        getStructured(structured, ['发证日期', '签发日期'])
    );

    if (!result.name) {
        const companyLine = lines.find(line => /[\u4e00-\u9fa5]{4,}(公司|企业|学校|幼儿园|食堂|餐厅)/.test(line));
        if (companyLine) result.name = normalizeSpaces(companyLine);
    }

    if (/(冷冻食|藏食|食品销售（含冷藏冷冻食|热|食)$/.test(compact(result.businessScope))) {
        result.businessScope = appendNearbyContinuation(lines, result.businessScope, /^(品[)）]?[、，,]?.+|食类.+)/);
    }
    if (/管$/.test(compact(result.businessScope))) {
        result.businessScope = appendNearbyContinuation(lines, result.businessScope, /^理$/);
    }
    result.businessScope = appendBusinessScopeContinuations(lines, result.businessScope);
    result.businessScope = normalizeBusinessScope(result.businessScope);

    return result;
}

function parseBaiduOcrResult(data) {
    const words = data.words_result && !Array.isArray(data.words_result) ? data.words_result : data;
    const lines = linesFromOcr(data);
    const fullText = lines.join('\n');
    const result = {
        name: '',
        licenseNo: '',
        type: '营业执照',
        legalPerson: '',
        address: '',
        validFrom: '',
        validUntil: '',
        issueAuthority: '',
        issueDate: '',
        establishDate: '',
        businessScope: '',
        words_result: data.words_result || []
    };

    result.name = getStructured(words, ['单位名称', '名称', '企业名称', '公司名称', 'name', 'companyname']) ||
        extractAfterLabel(lines, ['名称', '单位名称', '企业名称']);

    const licenseNo = getStructured(words, ['社会信用代码', '统一社会信用代码', '注册号', '证件编号', 'creditCode', 'regNum', 'reg_num', 'creditno']) ||
        extractAfterLabel(lines, ['统一社会信用代码', '社会信用代码', '注册号']);
    const licenseMatch = cleanLicenseNo(licenseNo || fullText).match(/[0-9A-Z]{18}/);
    if (licenseMatch) result.licenseNo = licenseMatch[0];

    result.legalPerson = getStructured(words, ['法定代表人', '法人', '经营者', '负责人', 'person', 'legal_person', 'legalperson']) ||
        extractAfterLabel(lines, ['法定代表人', '法人', '负责人']);

    result.businessScope = getStructured(words, ['经营范围', '业务范围', 'business', 'business_scope', 'businessscope']) ||
        extractAfterLabel(lines, ['经营范围', '业务范围'], { maxLookahead: 5 });

    result.address = getStructured(words, ['住所', '地址', '经营场所', 'address']) ||
        extractAfterLabel(lines, ['住所', '地址', '经营场所'], { maxLookahead: 3 });

    const validDate = getStructured(words, ['营业期限', '有效期', '经营期限', 'validDate', 'business_term']);
    const range = extractDateRange(validDate || extractAfterLabel(lines, ['营业期限', '有效期', '经营期限']) || fullText);
    result.validFrom = range.from;
    result.validUntil = range.until;
    result.issueAuthority = getStructured(words, ['登记机关', '发证机关', 'issueAuthority', 'issue_authority']) ||
        extractAfterLabel(lines, ['登记机关', '发证机关'], { maxLookahead: 3 });
    result.establishDate = getStructured(words, ['成立日期', 'establishDate', 'establish_date', 'foundDate', 'found_date']) ||
        extractAfterLabel(lines, ['成立日期'], { maxLookahead: 3 });
    result.establishDate = normalizeDate(result.establishDate) || result.establishDate;

    result.issueDate = getStructured(words, ['发证日期', '核准日期', '登记日期', '签发日期', 'issueDate', 'issue_date', 'approvalDate', 'approval_date']) ||
        extractAfterLabel(lines, ['发证日期', '核准日期', '登记日期', '签发日期'], { maxLookahead: 3 });
    result.issueDate = normalizeDate(result.issueDate) ||
        extractDates(fullText).find(date => date !== result.validFrom && date !== result.validUntil && date !== result.establishDate) ||
        '';

    const typeValue = getStructured(words, ['证照类型', '类型', 'type']);
    if (/食品经营/.test(typeValue || result.businessScope || fullText)) {
        result.type = '食品经营许可证';
    }

    return result;
}

module.exports = {
    parseGeneralOcrForFoodLicense,
    parseBaiduOcrResult,
    normalizeDate,
    extractDateRange
};
