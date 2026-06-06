const { test, expect } = require('@playwright/test');

async function loginAsAdmin(request) {
  const res = await request.post('/api/auth/login', {
    data: { username: 'admin', password: '123456' }
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return body.token;
}

test('admin can batch import all supplier categories through JSON APIs', async ({ request }) => {
  const token = await loginAsAdmin(request);
  const timestamp = Date.now();
  const categories = [
    { api: '/api/ingredient-suppliers', prefix: 'ing', extra: { mainProducts: 'rice, vegetables' } },
    { api: '/api/catering-companies', prefix: 'cat', extra: { dailyCapacity: '1200', currentSupply: 300, emergencyBackup: 'no' } },
    { api: '/api/operation-suppliers', prefix: 'op', extra: { operatedCanteens: '3' } },
    { api: '/api/service-suppliers', prefix: 'svc', extra: { serviceScope: 'testing service' } }
  ];

  const createdIds = [];
  try {
    for (const category of categories) {
      const supplier = {
        name: `Batch Import ${category.prefix} ${timestamp}`,
        code: `BATCH-${category.prefix}-${timestamp}`,
        companyType: 'Limited Company',
        region: 'Test Region',
        address: 'Test Address',
        legalPerson: 'Test Person',
        phone: '13800000000',
        capital: '100',
        establishDate: '2026-01-01',
        businessScope: 'Test scope',
        ...category.extra
      };

      const res = await request.post(`${category.api}/batch-import`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { suppliers: [supplier] }
      });
      expect(res.status(), `${category.api}/batch-import should accept imports`).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(1);
      expect(body.failed).toBe(0);
      expect(body.imported[0].id).toBeTruthy();
      createdIds.push({ api: category.api, id: body.imported[0].id });
    }
  } finally {
    for (const item of createdIds) {
      await request.delete(`${item.api}/${item.id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
    }
  }
});
