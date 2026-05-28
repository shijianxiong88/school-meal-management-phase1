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
  const login = await request('POST', '/api/auth/login', '', { username: 'admin', password: '123456' });
  console.log('Login:', login.status, login.body.user?.name);
  const token = login.body.token;

  // 10家食材供应商
  const ingredients = [
    { name: '福州海峡食材配送有限公司', code: '91350100154400001X', companyType: '有限责任公司', region: '福建省福州市', address: '福州市台江区工业路198号', legalPerson: '林志明', phone: '0591-83330001', capital: '5000', establishDate: '2010-03-15', businessScope: '食材配送、农产品初加工、冷链物流', mainProducts: '蔬菜、肉类、水产品、粮油、调味品' },
    { name: '泉州绿野食材贸易有限公司', code: '91350500154400002Y', companyType: '有限责任公司', region: '福建省泉州市', address: '泉州市丰泽区北峰街道农贸物流园', legalPerson: '陈志强', phone: '0595-22330002', capital: '3000', establishDate: '2012-06-20', businessScope: '食材销售、农产品采购、冷链仓储', mainProducts: '蔬菜、水果、食用菌、有机农产品' },
    { name: '厦门海韵食材供应链有限公司', code: '91350200154400003Z', companyType: '有限责任公司', region: '福建省厦门市', address: '厦门市同安区食品工业园区', legalPerson: '黄文杰', phone: '0592-70330003', capital: '8000', establishDate: '2008-09-10', businessScope: '食材供应链管理、集体用餐配送、中央厨房运营', mainProducts: '粮油、蔬菜、肉类、预制菜' },
    { name: '漳州三联食材有限公司', code: '91350600154400004A', companyType: '股份有限公司', region: '福建省漳州市', address: '漳州市芗城区金峰工业区', legalPerson: '张伟豪', phone: '0596-25530004', capital: '4000', establishDate: '2015-01-08', businessScope: '食材配送、餐饮服务、农产品直销', mainProducts: '粮食、食用油、调味品、农副产品' },
    { name: '莆田福辉食材有限公司', code: '91350300154400005B', companyType: '有限责任公司', region: '福建省莆田市', address: '莆田市涵江区食品加工基地', legalPerson: '李国辉', phone: '0594-29930005', capital: '2500', establishDate: '2016-04-25', businessScope: '食材批发配送、农产品购销、冷链物流', mainProducts: '海鲜、蔬菜、水果、冻品' },
    { name: '龙岩客家食材有限公司', code: '91350800154400006C', companyType: '有限责任公司', region: '福建省龙岩市', address: '龙岩市新罗区东城食品物流园', legalPerson: '王建平', phone: '0597-23330006', capital: '2000', establishDate: '2018-07-12', businessScope: '食材配送、餐饮管理、农产品收购', mainProducts: '山珍、食用菌、笋类、客家特产' },
    { name: '宁德海都食材有限公司', code: '91350900154400007D', companyType: '有限责任公司', region: '福建省宁德市', address: '宁德市蕉城区城南工业园区', legalPerson: '陈惠珍', phone: '0593-28730007', capital: '3500', establishDate: '2013-11-30', businessScope: '食材配送、水产品加工、冷链仓储', mainProducts: '海鲜、贝类、紫菜、海带' },
    { name: '三明绿康食材有限公司', code: '91350400154400008E', companyType: '有限责任公司', region: '福建省三明市', address: '三明市梅列区陈大镇农业产业园区', legalPerson: '刘永强', phone: '0598-82230008', capital: '2800', establishDate: '2017-02-18', businessScope: '食材销售、农产品种植、冷链配送', mainProducts: '蔬菜、水果、食用菌、有机食品' },
    { name: '南平武夷食材有限公司', code: '91350700154400009F', companyType: '有限责任公司', region: '福建省南平市', address: '南平市延平区水南街道农产品交易中心', legalPerson: '吴秀英', phone: '0599-86130009', capital: '2200', establishDate: '2019-05-22', businessScope: '食材配送、餐饮服务、茶食品加工', mainProducts: '茶叶制品、农产品、调味品、食品' },
    { name: '晋江鑫源食材有限公司', code: '91350582154400010G', companyType: '有限责任公司', region: '福建省泉州市', address: '泉州市晋江市陈埭镇食品工业园', legalPerson: '蔡明辉', phone: '0595-85130010', capital: '6000', establishDate: '2011-08-05', businessScope: '食材配送、集体用餐配送、农产品购销', mainProducts: '粮油、蔬菜、肉类、水产品、预制菜' },
  ];

  // 5家委托经营企业
  const operations = [
    { name: '厦门中快餐饮管理有限公司', code: '91350200MA67890011', companyType: '有限责任公司', region: '福建省厦门市', address: '厦门市思明区莲前东路268号', legalPerson: '郑文龙', phone: '0592-5938001', capital: '5000', establishDate: '2006-05-18', businessScope: '餐饮管理、食堂承包经营、物业管理', operatedCanteens: '15' },
    { name: '泉州膳食缘餐饮管理有限公司', code: '91350500MA67890022', companyType: '有限责任公司', region: '福建省泉州市', address: '泉州市鲤城区美食街168号', legalPerson: '李雅婷', phone: '0595-2280002', capital: '3000', establishDate: '2010-09-28', businessScope: '餐饮管理、食堂委托经营、食材配送', operatedCanteens: '8' },
    { name: '福州金管家餐饮管理有限公司', code: '91350100MA67890033', companyType: '有限责任公司', region: '福建省福州市', address: '福州市鼓楼区温泉路88号', legalPerson: '陈金水', phone: '0591-8780003', capital: '4000', establishDate: '2008-12-10', businessScope: '食堂承包经营、餐饮管理服务、物业管理', operatedCanteens: '12' },
    { name: '莆田味美餐饮管理有限公司', code: '91350300MA67890044', companyType: '有限责任公司', region: '福建省莆田市', address: '莆田市城厢区学园北路200号', legalPerson: '方志远', phone: '0594-2680004', capital: '2500', establishDate: '2014-03-08', businessScope: '餐饮管理、食堂委托经营、餐饮策划', operatedCanteens: '6' },
    { name: '漳州乐口餐饮管理有限公司', code: '91350600MA67890055', companyType: '有限责任公司', region: '福建省漳州市', address: '漳州市龙文区碧湖路58号', legalPerson: '黄晓燕', phone: '0596-2130005', capital: '2800', establishDate: '2016-07-15', businessScope: '食堂承包经营、餐饮管理、食品加工', operatedCanteens: '5' },
  ];

  // 5家校外供餐企业
  const caterings = [
    { name: '厦门美海乐餐饮配送有限公司', code: '91350200MA34567890', companyType: '有限责任公司', region: '福建省厦门市', address: '厦门市同安区美禾六路21号', legalPerson: '陈志强', phone: '0592-6038899', capital: '5000', establishDate: '2012-08-20', businessScope: '集体用餐配送、餐饮管理服务、中央厨房经营', dailyCapacity: '50000', '应急备选企业': '是' },
    { name: '福州食惠餐饮配送有限公司', code: '91350100MA34567811', companyType: '有限责任公司', region: '福建省福州市', address: '福州市仓山区金山工业园15号', legalPerson: '林志勇', phone: '0591-83098001', capital: '8000', establishDate: '2009-06-12', businessScope: '集体用餐配送、食材供应链、中央厨房运营', dailyCapacity: '80000', '应急备选企业': '否' },
    { name: '泉州御膳坊餐饮配送有限公司', code: '91350500MA34567822', companyType: '有限责任公司', region: '福建省泉州市', address: '泉州市丰泽区东海街道食品工业园', legalPerson: '张荣辉', phone: '0595-2890002', capital: '6000', establishDate: '2013-04-18', businessScope: '集体用餐配送、营养餐制作、餐饮管理', dailyCapacity: '60000', '应急备选企业': '是' },
    { name: '漳州鑫鼎餐饮配送有限公司', code: '91350600MA34567833', companyType: '有限责任公司', region: '福建省漳州市', address: '漳州市芗城区金峰工业区12号', legalPerson: '陈志远', phone: '0596-2580003', capital: '4500', establishDate: '2015-10-25', businessScope: '集体用餐配送、快餐生产配送、餐饮服务', dailyCapacity: '45000', '应急备选企业': '否' },
    { name: '晋江膳百味餐饮配送有限公司', code: '91350582MA34567844', companyType: '有限责任公司', region: '福建省泉州市', address: '泉州市晋江市安海镇食品物流园', legalPerson: '颜国安', phone: '0595-8570004', capital: '5500', establishDate: '2011-02-28', businessScope: '集体用餐配送、餐饮管理服务、预制菜生产', dailyCapacity: '55000', '应急备选企业': '是' },
  ];

  const created = { ingredients: [], operations: [], caterings: [] };

  for (const s of ingredients) {
    const res = await request('POST', '/api/ingredient-suppliers', token, { ...s, academicYear: '2025-2026' });
    if (res.status !== 201 && res.status !== 200) {
      console.log('Ingredient ERROR:', res.status, s.name, res.body);
    } else {
      created.ingredients.push(res.body);
      console.log('Ingredient:', s.name, '→', res.body.id);
    }
  }

  for (const s of operations) {
    const res = await request('POST', '/api/operation-suppliers', token, { ...s, academicYear: '2025-2026' });
    if (res.status !== 201 && res.status !== 200) {
      console.log('Operation ERROR:', res.status, s.name, res.body);
    } else {
      created.operations.push(res.body);
      console.log('Operation:', s.name, '→', res.body.id);
    }
  }

  for (const s of caterings) {
    const res = await request('POST', '/api/catering-companies', token, { ...s, academicYear: '2025-2026' });
    if (res.status !== 201 && res.status !== 200) {
      console.log('Catering ERROR:', res.status, s.name, res.body);
    } else {
      created.caterings.push(res.body);
      console.log('Catering:', s.name, '→', res.body.id);
    }
  }

  // 创建用户账号
  console.log('\n--- 创建企业用户账号 ---');
  const accounts = [];

  for (let i = 0; i < created.ingredients.length; i++) {
    const ent = created.ingredients[i];
    const username = 'ing' + String(i + 1).padStart(3, '0');
    const res = await request('POST', '/api/users', token, {
      username, name: ent.name, role: 'enterprise', region: ent.region
    });
    accounts.push({ username, company: ent.name, status: res.status, msg: res.body.message || res.body.error || 'OK' });
    console.log(`Ingredient user [${username}]:`, res.status, res.body.message || res.body.error);
  }

  for (let i = 0; i < created.operations.length; i++) {
    const ent = created.operations[i];
    const username = 'op' + String(i + 1).padStart(3, '0');
    const res = await request('POST', '/api/users', token, {
      username, name: ent.name, role: 'enterprise', region: ent.region
    });
    accounts.push({ username, company: ent.name, status: res.status, msg: res.body.message || res.body.error || 'OK' });
    console.log(`Operation user [${username}]:`, res.status, res.body.message || res.body.error);
  }

  for (let i = 0; i < created.caterings.length; i++) {
    const ent = created.caterings[i];
    const username = 'cat' + String(i + 1).padStart(3, '0');
    const res = await request('POST', '/api/users', token, {
      username, name: ent.name, role: 'enterprise', region: ent.region
    });
    accounts.push({ username, company: ent.name, status: res.status, msg: res.body.message || res.body.error || 'OK' });
    console.log(`Catering user [${username}]:`, res.status, res.body.message || res.body.error);
  }

  console.log('\n完成！');
  console.log(`- 食材供应商: ${created.ingredients.length}家 (ing001~ing010 / 123456)`);
  console.log(`- 委托经营企业: ${created.operations.length}家 (op001~op005 / 123456)`);
  console.log(`- 校外供餐企业: ${created.caterings.length}家 (cat001~cat005 / 123456)`);
}

main().catch(console.error);