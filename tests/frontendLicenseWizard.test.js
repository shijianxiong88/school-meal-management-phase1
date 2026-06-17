const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function extractCredentialsPage() {
  const start = html.indexOf('function CredentialsPage()');
  const end = html.indexOf('function CredentialModal', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return html.slice(start, end);
}

test('license create save handlers return duplicate confirmation responses to the wizard', () => {
  const duplicateReturns = html.match(/if\s*\(\s*e\.requiresConfirmation\s*\)\s*return\s+e\s*;/g) || [];
  assert.equal(duplicateReturns.length >= 2, true);
});

test('credentials page has separate create actions for licenses and certificates', () => {
  assert.match(html, />\+ 新增证照<\/button>/);
  assert.match(html, />\+ 新增证书<\/button>/);
});

test('certificate create action saves to credentials API', () => {
  assert.match(html, /apiFetch\('\/credentials', \{ method: 'POST'/);
});

test('credentials page table omits duplicate owner name column', () => {
  const page = extractCredentialsPage();
  assert.doesNotMatch(page, /<th>鎵€灞炰富浣?/);
  assert.doesNotMatch(page, /<th>所属主体<\/th>/);
  assert.match(page, /colSpan="6"/);
  assert.doesNotMatch(page, /colSpan="7"/);
});
