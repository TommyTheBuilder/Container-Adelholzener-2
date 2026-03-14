const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRedirectUrl,
  createSsoResponse,
  signSsoToken,
  validateSharedSessionToken
} = require('../sso');

test('buildRedirectUrl uses ? when URL has no query', () => {
  const url = buildRedirectUrl('https://container.example.com/driver', 'ssoToken', 'abc');
  assert.equal(url, 'https://container.example.com/driver?ssoToken=abc');
});

test('buildRedirectUrl uses & when URL already has query', () => {
  const url = buildRedirectUrl('https://container.example.com/driver?lang=de', 'ssoToken', 'abc');
  assert.equal(url, 'https://container.example.com/driver?lang=de&ssoToken=abc');
});

test('validateSharedSessionToken accepts valid token', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = signSsoToken({ user: 'alice', roles: ['integration.container_login'], exp: now + 120 }, 'secret');
  const validated = validateSharedSessionToken(token, 'secret');

  assert.equal(validated.ok, true);
  assert.equal(validated.user, 'alice');
});

test('validateSharedSessionToken rejects expired token', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = signSsoToken({ user: 'alice', exp: now - 10 }, 'secret');
  const validated = validateSharedSessionToken(token, 'secret');

  assert.equal(validated.ok, false);
  assert.equal(validated.reason, 'expired');
});

test('validateSharedSessionToken rejects invalid signature', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = signSsoToken({ user: 'alice', exp: now + 120 }, 'secret1');
  const validated = validateSharedSessionToken(token, 'secret2');

  assert.equal(validated.ok, false);
  assert.equal(validated.reason, 'invalid_signature');
});

test('createSsoResponse provides unified payload fields', () => {
  const response = createSsoResponse({
    targetUrl: 'https://container.example.com/admin?foo=bar',
    tokenTtlSeconds: 60,
    tokenSecret: 'secret',
    tokenParamName: 'ssoToken',
    user: 'alice',
    authSource: 'session_cookie'
  });

  assert.equal(response.ok, true);
  assert.equal(response.ssoToken, response.token);
  assert.equal(response.token, response.session);
  assert.match(response.url, /[?&]ssoToken=/);
  assert.equal(response.authSource, 'session_cookie');
});
