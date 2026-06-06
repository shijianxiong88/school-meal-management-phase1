const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSelectionWorkflowDetail } = require('../server/selectionWorkflow');

const records = {
  announcements: [
    { id: 'ann-1', schoolId: 'school-1', title: 'School 1 selection' },
    { id: 'ann-2', schoolId: 'school-2', title: 'School 2 selection' }
  ],
  registrations: [
    { id: 'reg-1', announcementId: 'ann-1', enterpriseName: 'A' },
    { id: 'reg-2', announcementId: 'ann-2', enterpriseName: 'B' }
  ],
  candidates: [
    { id: 'cand-1', announcementId: 'ann-1', confirmedEnterprises: [{ enterpriseName: 'A' }] }
  ],
  inspections: [
    { id: 'insp-1', announcementId: 'ann-1', enterpriseName: 'A' }
  ],
  shortlisted: [
    { id: 'short-1', announcementId: 'ann-1', shortlistedEnterprises: [{ enterpriseName: 'A' }] }
  ],
  results: [
    { id: 'res-1', announcementId: 'ann-1', winningEnterprise: { enterpriseName: 'A' } }
  ],
  contracts: [
    { id: 'contract-1', announcementId: 'ann-1', enterpriseName: 'A' }
  ]
};

test('builds full selection workflow detail for city users', () => {
  const detail = buildSelectionWorkflowDetail(records, 'ann-1', { role: 'admin' });

  assert.equal(detail.announcement.id, 'ann-1');
  assert.equal(detail.registrations.length, 1);
  assert.equal(detail.candidates.length, 1);
  assert.equal(detail.inspections.length, 1);
  assert.equal(detail.shortlisted.length, 1);
  assert.equal(detail.results.length, 1);
  assert.equal(detail.contracts.length, 1);
});

test('school users cannot view another school selection workflow', () => {
  assert.throws(
    () => buildSelectionWorkflowDetail(records, 'ann-1', { role: 'school', schoolId: 'school-2' }),
    /permission/
  );
});
