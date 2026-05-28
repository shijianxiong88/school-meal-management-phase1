const http = require('http');

function request(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: 'localhost', port: 3000, path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      }
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request(opts, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(b) }); }
        catch (e) { resolve({ status: res.statusCode, body: b }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  // Login as admin
  const login = await request('POST', '/api/auth/login', '', { username: 'admin', password: '123456' });
  console.log('Login:', login.status, login.body.user?.name);
  const token = login.body.token;

  // ============================================================
  // 10所新学校
  // ============================================================

  // 5所自办食堂学校（校内供餐 + 自营食堂）
  const selfSchools = [
    { name: '晋江市第一中学', code: 'JJYZX001', region: '青阳街道', contact: '张明', phone: '0595-82000001', studentCount: '1200', staffCount: '85', type: '高中', address: '晋江市青阳街道和平路1号', 营养改善计划: '否', department: '晋江市教育局', leader: '张明', bankName: '中国建设银行', bankAccount: '6217001830012345678' },
    { name: '晋江市第二中学', code: 'JJYZX002', region: '梅岭街道', contact: '李华', phone: '0595-82000002', studentCount: '980', staffCount: '72', type: '初中', address: '晋江市梅岭街道胜利路2号', 营养改善计划: '是', department: '晋江市教育局', leader: '李华', bankName: '中国工商银行', bankAccount: '6217001830012345679' },
    { name: '晋江市第三小学', code: 'JJYZX003', region: '西园街道', contact: '王芳', phone: '0595-82000003', studentCount: '650', staffCount: '45', type: '小学', address: '晋江市西园街道建设路3号', 营养改善计划: '否', department: '晋江市教育局', leader: '王芳', bankName: '中国农业银行', bankAccount: '6217001830012345680' },
    { name: '晋江市第四小学', code: 'JJYZX004', region: '罗山街道', contact: '陈强', phone: '0595-82000004', studentCount: '580', staffCount: '38', type: '小学', address: '晋江市罗山街道开发路4号', 营养改善计划: '否', department: '晋江市教育局', leader: '陈强', bankName: '中国银行', bankAccount: '6217001830012345681' },
    { name: '晋江市第五中学', code: 'JJYZX005', region: '灵源街道', contact: '刘霞', phone: '0595-82000005', studentCount: '750', staffCount: '55', type: '初中', address: '晋江市灵源街道兴业路5号', 营养改善计划: '是', department: '晋江市教育局', leader: '刘霞', bankName: '中国建设银行', bankAccount: '6217001830012345682' },
  ];

  // 2所委托经营学校（校内供餐 + 委托经营食堂）
  const delegateSchools = [
    { name: '晋江市第六中学', code: 'JJYZX006', region: '新塘街道', contact: '赵伟', phone: '0595-82000006', studentCount: '1100', staffCount: '78', type: '初中', address: '晋江市新塘街道光明路6号', 营养改善计划: '否', department: '晋江市教育局', leader: '赵伟', bankName: '中国工商银行', bankAccount: '6217001830012345683' },
    { name: '晋江市第七小学', code: 'JJYZX007', region: '陈埭镇', contact: '周敏', phone: '0595-82000007', studentCount: '420', staffCount: '30', type: '小学', address: '晋江市陈埭镇工业园路7号', 营养改善计划: '否', department: '晋江市教育局', leader: '周敏', bankName: '中国农业银行', bankAccount: '6217001830012345684' },
  ];

  // 3所校外供餐学校（校外供餐）
  const externalSchools = [
    { name: '晋江市第八中学', code: 'JJYZX008', region: '池店镇', contact: '吴涛', phone: '0595-82000008', studentCount: '890', staffCount: '62', type: '初中', address: '晋江市池店镇政府路8号', 营养改善计划: '否', department: '晋江市教育局', leader: '吴涛', bankName: '中国银行', bankAccount: '6217001830012345685' },
    { name: '晋江市第九小学', code: 'JJYZX009', region: '东石镇', contact: '郑琳', phone: '0595-82000009', studentCount: '380', staffCount: '28', type: '小学', address: '晋江市东石镇海滨路9号', 营养改善计划: '否', department: '晋江市教育局', leader: '郑琳', bankName: '中国建设银行', bankAccount: '6217001830012345686' },
    { name: '晋江市第十小学', code: 'JJYZX010', region: '永和镇', contact: '孙鹏', phone: '0595-82000010', studentCount: '290', staffCount: '22', type: '小学', address: '晋江市永和镇中学路10号', 营养改善计划: '否', department: '晋江市教育局', leader: '孙鹏', bankName: '中国工商银行', bankAccount: '6217001830012345687' },
  ];

  // 创建自办食堂学校
  const createdSelfSchools = [];
  for (const s of selfSchools) {
    const res = await request('POST', '/api/schools', token, {
      ...s,
      供餐类型: ['校内供餐'],
      canteenCount: 0,
      academicYear: '2025-2026'
    });
    if (res.status !== 201 && res.status !== 200) {
      console.log('Create self school ERROR:', res.status, res.body);
    } else {
      createdSelfSchools.push(res.body);
      console.log('Self school:', res.status, s.name, '→', res.body.id);
    }
  }

  // 创建委托经营学校
  const createdDelegateSchools = [];
  for (const s of delegateSchools) {
    const res = await request('POST', '/api/schools', token, {
      ...s,
      供餐类型: ['校内供餐'],
      canteenCount: 0,
      academicYear: '2025-2026'
    });
    if (res.status !== 201 && res.status !== 200) {
      console.log('Create delegate school ERROR:', res.status, res.body);
    } else {
      createdDelegateSchools.push(res.body);
      console.log('Delegate school:', res.status, s.name, '→', res.body.id);
    }
  }

  // 创建校外供餐学校
  const createdExternalSchools = [];
  for (const s of externalSchools) {
    const res = await request('POST', '/api/schools', token, {
      ...s,
      供餐类型: ['校外供餐'],
      canteenCount: 0,
      academicYear: '2025-2026'
    });
    if (res.status !== 201 && res.status !== 200) {
      console.log('Create external school ERROR:', res.status, res.body);
    } else {
      createdExternalSchools.push(res.body);
      console.log('External school:', res.status, s.name, '→', res.body.id);
    }
  }

  // ============================================================
  // 7个食堂：5个自营 + 2个委托经营
  // ============================================================
  const selfCanteens = [
    { name: '晋江市第一中学食堂', code: 'JJYZX001-CT', address: '晋江市青阳街道和平路1号', manager: '张明', phone: '0595-82000011', financeStaff: '出纳A', financePhone: '0595-82000021', area: '1200', capacity: '1200', staffCount: '25', operationMode: '自营', 营养改善计划食堂: '否', foodSafetyStaff: '安全员A', foodSafetyPhone: '0595-82000031', 食品安全险: '是', 明厨亮灶: '是' },
    { name: '晋江市第二中学食堂', code: 'JJYZX002-CT', address: '晋江市梅岭街道胜利路2号', manager: '李华', phone: '0595-82000012', financeStaff: '出纳B', financePhone: '0595-82000022', area: '1000', capacity: '1000', staffCount: '20', operationMode: '自营', 营养改善计划食堂: '是', foodSafetyStaff: '安全员B', foodSafetyPhone: '0595-82000032', 食品安全险: '是', 明厨亮灶: '是' },
    { name: '晋江市第三小学食堂', code: 'JJYZX003-CT', address: '晋江市西园街道建设路3号', manager: '王芳', phone: '0595-82000013', financeStaff: '出纳C', financePhone: '0595-82000023', area: '600', capacity: '650', staffCount: '12', operationMode: '自营', 营养改善计划食堂: '否', foodSafetyStaff: '安全员C', foodSafetyPhone: '0595-82000033', 食品安全险: '是', 明厨亮灶: '是' },
    { name: '晋江市第四小学食堂', code: 'JJYZX004-CT', address: '晋江市罗山街道开发路4号', manager: '陈强', phone: '0595-82000014', financeStaff: '出纳D', financePhone: '0595-82000024', area: '550', capacity: '580', staffCount: '10', operationMode: '自营', 营养改善计划食堂: '否', foodSafetyStaff: '安全员D', foodSafetyPhone: '0595-82000034', 食品安全险: '是', 明厨亮灶: '是' },
    { name: '晋江市第五中学食堂', code: 'JJYZX005-CT', address: '晋江市灵源街道兴业路5号', manager: '刘霞', phone: '0595-82000015', financeStaff: '出纳E', financePhone: '0595-82000025', area: '800', capacity: '750', staffCount: '15', operationMode: '自营', 营养改善计划食堂: '是', foodSafetyStaff: '安全员E', foodSafetyPhone: '0595-82000035', 食品安全险: '是', 明厨亮灶: '是' },
  ];

  const delegateCanteens = [
    { name: '晋江市第六中学食堂', code: 'JJYZX006-CT', address: '晋江市新塘街道光明路6号', manager: '赵伟', phone: '0595-82000016', financeStaff: '出纳F', financePhone: '0595-82000026', area: '1100', capacity: '1100', staffCount: '22', operationMode: '委托经营', 营养改善计划食堂: '否', foodSafetyStaff: '安全员F', foodSafetyPhone: '0595-82000036', 食品安全险: '是', 明厨亮灶: '是' },
    { name: '晋江市第七小学食堂', code: 'JJYZX007-CT', address: '晋江市陈埭镇工业园路7号', manager: '周敏', phone: '0595-82000017', financeStaff: '出纳G', financePhone: '0595-82000027', area: '500', capacity: '420', staffCount: '8', operationMode: '委托经营', 营养改善计划食堂: '否', foodSafetyStaff: '安全员G', foodSafetyPhone: '0595-82000037', 食品安全险: '是', 明厨亮灶: '是' },
  ];

  // 创建自营食堂
  for (let i = 0; i < selfCanteens.length; i++) {
    const c = selfCanteens[i];
    const schoolId = createdSelfSchools[i]?.id;
    if (!schoolId) { console.log('Skip self canteen', i, '- no schoolId'); continue; }
    const res = await request('POST', '/api/canteens', token, {
      ...c,
      schoolId,
      status: '正常运营',
      academicYear: '2025-2026'
    });
    if (res.status !== 201 && res.status !== 200) {
      console.log('Create self canteen ERROR:', res.status, res.body);
    } else {
      console.log('Self canteen:', res.status, c.name, '→', res.body.id);
    }
  }

  // 创建委托经营食堂
  for (let i = 0; i < delegateCanteens.length; i++) {
    const c = delegateCanteens[i];
    const schoolId = createdDelegateSchools[i]?.id;
    if (!schoolId) { console.log('Skip delegate canteen', i, '- no schoolId'); continue; }
    const res = await request('POST', '/api/canteens', token, {
      ...c,
      schoolId,
      status: '正常运营',
      academicYear: '2025-2026'
    });
    if (res.status !== 201 && res.status !== 200) {
      console.log('Create delegate canteen ERROR:', res.status, res.body);
    } else {
      console.log('Delegate canteen:', res.status, c.name, '→', res.body.id);
    }
  }

  console.log('\n完成！');
  console.log('- 5所自办食堂学校已创建（+5个自营食堂）');
  console.log('- 2所委托经营学校已创建（+2个委托经营食堂）');
  console.log('- 3所校外供餐学校已创建（无食堂）');
}

main().catch(console.error);