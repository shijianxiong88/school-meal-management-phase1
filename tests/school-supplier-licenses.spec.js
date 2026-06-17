const { test, expect } = require('@playwright/test');

async function loginAsSchool(request, username) {
  const res = await request.post('/api/auth/login', {
    data: { username, password: '123456', role: 'school' }
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return body.token;
}

test('school supplier licenses include current contract enterprise licenses', async ({ request }) => {
  const token = await loginAsSchool(request, 'school109');

  const res = await request.get('/api/school/enterprise-licenses', {
    headers: { Authorization: `Bearer ${token}` }
  });

  expect(res.status()).toBe(200);
  const licenses = await res.json();
  const yueTaiFoodLicense = licenses.find(license =>
    license.ownerName === '泉州市悦泰餐饮服务有限公司' &&
    license.licenseNo === 'JY23505810223178'
  );

  expect(yueTaiFoodLicense).toBeTruthy();
  expect(yueTaiFoodLicense.contractNo).toBe('XL-CTR-2026-002');
  expect(yueTaiFoodLicense.contractEndDate).toBe('2027-06-05');
});
