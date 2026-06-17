const assert = require('assert');
const { parseBaiduOcrResult, parseGeneralOcrForFoodLicense } = require('./server/ocrParser');

function words(lines) {
    return { words_result: lines.map(line => ({ words: line })) };
}

const foodResult = parseGeneralOcrForFoodLicense(words([
    '食品经营许可证',
    '经 营 者 名 称： 阳新县翔鹏教育咨询有限公司',
    '统一社会信用代码：（身份证号码） 91420222MADXAY8RXJ',
    '法定代表人（负责人）： 倪文武',
    '住 所： 湖北省黄石市阳新县白沙镇白沙铺村',
    '经 营 场 所： 湖北省黄石市阳新县白沙镇白沙铺村港西组',
    '主 体 业 态： 集中用餐单位食堂',
    '经 营 项 目： 热食类食品制售',
    '许 可 证 编 号： JY34202220183637',
    '有效期至 2029 年 11 月 18 日',
    '2024 年 11 月 19 日'
]));

assert.strictEqual(foodResult.type, '食品经营许可证');
assert.strictEqual(foodResult.name, '阳新县翔鹏教育咨询有限公司');
assert.strictEqual(foodResult.licenseNo, 'JY34202220183637');
assert.strictEqual(foodResult.legalPerson, '倪文武');
assert.strictEqual(foodResult.validFrom, '2024-11-19');
assert.strictEqual(foodResult.validUntil, '2029-11-18');
assert.strictEqual(foodResult.businessScope, '热食类食品制售');

const businessResult = parseBaiduOcrResult({
    words_result: {
        单位名称: { words: '北京妙村吉丽服务有限公司' },
        社会信用代码: { words: '91110108MA01EBFH9B' },
        法定代表人: { words: '孙钢' },
        经营范围: { words: '托育服务；技术开发；餐饮管理。' },
        营业期限: { words: '2018年04月29日至长期' },
        成立日期: { words: '2018年04月29日' },
        核准日期: { words: '2020年05月21日' }
    }
});

assert.strictEqual(businessResult.type, '营业执照');
assert.strictEqual(businessResult.name, '北京妙村吉丽服务有限公司');
assert.strictEqual(businessResult.licenseNo, '91110108MA01EBFH9B');
assert.strictEqual(businessResult.legalPerson, '孙钢');
assert.strictEqual(businessResult.validFrom, '2018-04-29');
assert.strictEqual(businessResult.validUntil, '2099-12-31');
assert.strictEqual(businessResult.establishDate, '2018-04-29');
assert.strictEqual(businessResult.issueDate, '2020-05-21');
assert.strictEqual(businessResult.businessScope, '托育服务；技术开发；餐饮管理。');

const structuredFoodResult = parseGeneralOcrForFoodLicense({
    words_result: {
        经营者名称: [{ word: '阳新县翔鹏教育咨询有限公司' }],
        许可证编号: [{ word: 'JY34202220183637' }],
        法定代表人: [{ word: '倪文武' }],
        经营项目: [{ word: '热食类食品制售' }],
        有效期至: [{ word: '2029年11月18日' }]
    }
});

assert.strictEqual(structuredFoodResult.name, '阳新县翔鹏教育咨询有限公司');
assert.strictEqual(structuredFoodResult.licenseNo, 'JY34202220183637');
assert.strictEqual(structuredFoodResult.legalPerson, '倪文武');
assert.strictEqual(structuredFoodResult.validUntil, '2029-11-18');
assert.strictEqual(structuredFoodResult.businessScope, '热食类食品制售');

const realFoodResult = parseGeneralOcrForFoodLicense(words([
    '食品经营许可证',
    '泉州市康禾餐饮管理有限公司',
    '经营者名称：',
    '许可证编号：',
    'JY23505980025516',
    '统一社会信用代码：',
    '91350582MA334KFK0D',
    '日常监督管理机构：',
    '泉州市市场监督管理局泉州经济技术开',
    '(身份证号码)',
    '发区分局',
    '法定代表人（负责人）：',
    '李群燕',
    '日常监督管理人员：',
    '林健、郑青萍',
    '住所：',
    '福建省泉州经济技术开发区美泰路42号综',
    '投诉举报电话：',
    '12315',
    '合楼101、302',
    '经营场所：',
    '福建省泉州经济技术开发区美泰路42号',
    '发证机关：',
    '泉州市市场监督管理局泉州经济技术开',
    '综合楼101、302',
    '餐饮服务经营者（大型餐馆，集体用餐',
    '发区分局',
    '主体业态：',
    '配送)',
    '经营项目：',
    '热食类食品制售',
    '签发人：',
    '王小芳',
    '2024年10月25日',
    '有效期至2029年06月19日',
    '国家市场监督管理总局监制'
]));

assert.strictEqual(realFoodResult.name, '泉州市康禾餐饮管理有限公司');
assert.strictEqual(realFoodResult.licenseNo, 'JY23505980025516');
assert.strictEqual(realFoodResult.legalPerson, '李群燕');
assert.strictEqual(realFoodResult.address, '福建省泉州经济技术开发区美泰路42号综');
assert.strictEqual(realFoodResult.subjectType, '餐饮服务经营者（大型餐馆，集体用餐配送)');
assert.strictEqual(realFoodResult.businessScope, '热食类食品制售');
assert.strictEqual(realFoodResult.validUntil, '2029-06-19');
assert.strictEqual(realFoodResult.issueDate, '2024-10-25');

const secondFoodVersionResult = parseGeneralOcrForFoodLicense(words([
    '说明',
    '食品经营许可证',
    '1.《食品经营许可证》是食品经营者取得食品经营许可的合',
    '(副本)',
    '法凭证。',
    '2.《食品经营许可证》分为正本、副本。正本、副本具有同',
    '等法律效力。正本应当悬挂或摆放在经营场所的显著位置。',
    '经营者名称：',
    '晋江市新绿健餐饮服务有限责任公司',
    '3.《食品经营许可证》不得伪造、涂改、倒卖、出租、出借',
    '或者以其他形式非法转让。',
    '统一社会信用代码：',
    '92350582MA32F09037',
    '4.食品经营者应当在核准的许可范围内开展食品经营。',
    '(身份证号码)',
    '5.食品经营者应当接受市场监督管理部门的监督管理。',
    '法定代表人（负责人）：',
    '6.食品经营者改变许可事项应当申请变更食品经营许可。',
    '翁丽凤',
    '7.食品经营者应当在《食品经营许可证》有效期届满30个工',
    '住所：',
    '作日前，及时到原许可部门申请延续。',
    '福建省晋江市罗山苏内内塘东路162号',
    '经营场所：',
    '许可证编号：',
    '福建省晋江市罗山苏内内塘东路162号',
    '日常监督管理机构：',
    'JY23505820934686',
    '日常监督管理人员：',
    '罗山街道市场监督管理所',
    '主体业态：',
    '餐饮服务经营者（大型餐馆、集体用餐配',
    '投诉举报电话：',
    '12东3正陈',
    '经营项目：',
    '送)',
    '预包装食品销售（含冷藏冷冻食',
    '发证机关：',
    '品)、热食类食品制售',
    '晋江市市场监督管理局',
    '签发人：',
    '洪德意',
    '年',
    '月日',
    '2026',
    '01',
    '14',
    '有效期至',
    '2031',
    '年',
    '日',
    '01',
    '月',
    '13',
    '国家市场监督管理总局监制'
]));

assert.strictEqual(secondFoodVersionResult.name, '晋江市新绿健餐饮服务有限责任公司');
assert.strictEqual(secondFoodVersionResult.licenseNo, 'JY23505820934686');
assert.strictEqual(secondFoodVersionResult.legalPerson, '翁丽凤');
assert.strictEqual(secondFoodVersionResult.address, '福建省晋江市罗山苏内内塘东路162号');
assert.strictEqual(secondFoodVersionResult.issueAuthority, '晋江市市场监督管理局');
assert.strictEqual(secondFoodVersionResult.issueDate, '2026-01-14');
assert.strictEqual(secondFoodVersionResult.validUntil, '2031-01-13');
assert.strictEqual(secondFoodVersionResult.subjectType, '餐饮服务经营者（大型餐馆、集体用餐配送)');
assert.strictEqual(secondFoodVersionResult.businessScope, '预包装食品销售（含冷藏冷冻食品)、热食类食品制售');

const foldedFoodPhotoResult = parseGeneralOcrForFoodLicense(words([
    '食品经营许可证',
    '经',
    '营者名称：泉州市亿兴餐饮服务有限公司',
    '许可证编号：',
    'JY23505820903397',
    '统一社会信用代码：',
    '91350582A327LJ86H',
    '日常监督管理机构：',
    '梅岭街道市场监督管理所',
    '(身份证号码)',
    '法定代表人（负责人）：',
    '林春玲',
    '日常监督管理人员：',
    '柯',
    '住',
    '所：',
    '福建省晋江市桂华路65号',
    '投诉举报电话：1235到',
    '经',
    '营',
    '场',
    '所：福建省晋江市桂华路65号',
    '发证',
    '机关：',
    '晋江市市场着理局',
    '主',
    '体',
    '业',
    '态：',
    '餐饮服务经营者（特大型餐馆、集体用餐配送）',
    '经',
    '营',
    '项',
    '目：',
    '预包装食品销售（含冷藏冷冻食品）、热',
    '签',
    '发',
    '人：洪德意',
    '食类食品制售',
    '2025年',
    '07月',
    '09日',
    '有效期至',
    '2030年07月',
    '08日'
]));

assert.strictEqual(foldedFoodPhotoResult.type, '食品经营许可证');
assert.strictEqual(foldedFoodPhotoResult.name, '泉州市亿兴餐饮服务有限公司');
assert.strictEqual(foldedFoodPhotoResult.licenseNo, 'JY23505820903397');
assert.strictEqual(foldedFoodPhotoResult.legalPerson, '林春玲');
assert.strictEqual(foldedFoodPhotoResult.address, '福建省晋江市桂华路65号');
assert.strictEqual(foldedFoodPhotoResult.validUntil, '2030-07-08');
assert.strictEqual(foldedFoodPhotoResult.subjectType, '餐饮服务经营者（特大型餐馆、集体用餐配送）');
assert.strictEqual(foldedFoodPhotoResult.businessScope, '预包装食品销售（含冷藏冷冻食品）、热食类食品制售');

const rotatedFoodPhotoResult = parseGeneralOcrForFoodLicense(words([
    '食品经营许可证',
    '（副本)',
    '经营者名称：',
    '泉州市松花春水餐饮服务有限公司',
    '统一社会信用代码',
    '(身份证号码)',
    '91350582MA2D5WT74',
    '法绽代表人（负责人）：',
    '陈培铭',
    '住所：',
    '福建省晋江市灵源小浯塘锦山路50-1号',
    '经营场所：',
    '福建省晋江市灵源小浯塘锦山路50-1号地下一',
    '层、一横、二楼及三楼',
    '许可证编号：',
    '820937734',
    '日常监督管理机构：',
    '日常监督管理人负',
    '殇监督管理所',
    '主体业态：',
    '餐饮服务经营者（大型餐馆、集体用餐配送）',
    '经营项目：',
    '预包装食品销售（含冷藏冷冻食',
    '品)、热食类食品制售、餐饮服务管',
    '理',
    '发证',
    '机',
    '晋江市市场遮督管理局',
    '签',
    '发',
    '洪德意',
    '年',
    '月。',
    '日',
    '2026',
    '02',
    '05',
    '有效期至',
    '年了',
    '月',
    '日',
    '2031',
    '0204'
]));

assert.strictEqual(rotatedFoodPhotoResult.type, '食品经营许可证');
assert.strictEqual(rotatedFoodPhotoResult.name, '泉州市松花春水餐饮服务有限公司');
assert.strictEqual(rotatedFoodPhotoResult.legalPerson, '陈培铭');
assert.strictEqual(rotatedFoodPhotoResult.address, '福建省晋江市灵源小浯塘锦山路50-1号');
assert.strictEqual(rotatedFoodPhotoResult.issueAuthority, '晋江市市场监督管理局');
assert.strictEqual(rotatedFoodPhotoResult.issueDate, '2026-02-05');
assert.strictEqual(rotatedFoodPhotoResult.validUntil, '2031-02-04');
assert.strictEqual(rotatedFoodPhotoResult.subjectType, '餐饮服务经营者（大型餐馆、集体用餐配送）');
assert.strictEqual(rotatedFoodPhotoResult.businessScope, '预包装食品销售（含冷藏冷冻食品)、热食类食品制售、餐饮服务管理');

console.log('OCR parser tests passed');
