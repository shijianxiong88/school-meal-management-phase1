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

  // 1. Create ingredient supplier
  const ing = await request('POST', '/api/ingredient-suppliers', token, {
    name: '永辉超市股份有限公司',
    code: '91350100154478700P',
    companyType: '股份有限公司',
    region: '福建省福州市',
    address: '福州市鼓楼区西二环中路436号',
    legalPerson: '张轩松',
    phone: '0591-83768888',
    capital: '100000',
    establishDate: '2001-04-13',
    businessScope: '食品销售、农产品初加工、餐饮服务、物流配送',
    mainProducts: '粮油、蔬菜、肉类、水产品、调味品'
  });
  console.log('Ingredient Supplier:', ing.status, ing.body.name, ing.body.id);

  // 2. Create catering company
  const cat = await request('POST', '/api/catering-companies', token, {
    name: '厦门美海乐餐饮配送有限公司',
    code: '91350200MA34567890',
    companyType: '有限责任公司',
    region: '福建省厦门市',
    address: '厦门市同安区美禾六路21号',
    legalPerson: '陈志强',
    phone: '0592-6038899',
    capital: '5000',
    establishDate: '2012-08-20',
    businessScope: '集体用餐配送、餐饮管理服务、中央厨房经营',
    dailyCapacity: '50000',
    '应急备选企业': '是'
  });
  console.log('Catering Company:', cat.status, cat.body.name, cat.body.id);

  // 3. Create operation supplier
  const op = await request('POST', '/api/operation-suppliers', token, {
    name: '泉州中禾餐饮管理有限公司',
    code: '91350500MA67890123',
    companyType: '有限责任公司',
    region: '福建省泉州市',
    address: '泉州市丰泽区东海街道滨城社区东海大街888号',
    legalPerson: '林文斌',
    phone: '0595-22167890',
    capital: '3000',
    establishDate: '2015-03-10',
    businessScope: '餐饮管理、食堂承包经营、物业管理、食材配送',
    operatedCanteens: '8'
  });
  console.log('Operation Supplier:', op.status, op.body.name, op.body.id);

  // Create user accounts for each supplier (role='enterprise')
  const ingUser = await request('POST', '/api/users', token, {
    username: 'ingredient001', name: '永辉超市股份有限公司', role: 'enterprise', region: '福建省福州市'
  });
  console.log('Ingredient User:', ingUser.status, ingUser.body.message || ingUser.body.error);

  const catUser = await request('POST', '/api/users', token, {
    username: 'catering001', name: '厦门美海乐餐饮配送有限公司', role: 'enterprise', region: '福建省厦门市'
  });
  console.log('Catering User:', catUser.status, catUser.body.message || catUser.body.error);

  const opUser = await request('POST', '/api/users', token, {
    username: 'operation001', name: '泉州中禾餐饮管理有限公司', role: 'enterprise', region: '福建省泉州市'
  });
  console.log('Operation User:', opUser.status, opUser.body.message || opUser.body.error);

  console.log('\nDone! 3 suppliers + 3 user accounts created.');
  console.log('  ingredient001 / 123456');
  console.log('  catering001 / 123456');
  console.log('  operation001 / 123456');
}

main().catch(console.error);
