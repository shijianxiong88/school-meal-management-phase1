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
  // Login as school001
  const login = await request('POST', '/api/auth/login', '', { username: 'school001', password: '123456' });
  console.log('Login:', login.status, login.body.user?.name);

  const token = login.body.token;

  // Create canteen
  const result = await request('POST', '/api/canteens', token, {
    name: 'Test Canteen',
    code: 'TC001',
    address: 'Test Address',
    manager: 'Test Manager',
    phone: '13800138000',
    financeStaff: 'Finance',
    financePhone: '13800138001',
    area: '100',
    capacity: '200',
    staffCount: '10',
    operationMode: '自营',
    '营养改善计划食堂': '否',
    foodSafetyStaff: 'Safety',
    foodSafetyPhone: '13800138002',
    '食品安全险': '否',
    '明厨亮灶': '否',
    status: '正常运营'
  });
  console.log('Create:', result.status, JSON.stringify(result.body));
}

main().catch(console.error);
