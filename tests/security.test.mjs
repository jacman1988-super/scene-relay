import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callbackURL, stripOAuthURL, createNonce, makeOAuthURL, consumeOAuthFragment, OAUTH_SCOPE } from '../dist/security.mjs';

// Synthetic fixtures only: no real account credentials or provider requests.
const token = 'syntheticTokenForLocalTests0123456789';
const state = 'ab'.repeat(32);
const clientId = 'publicClientId1234567890';
const redirectUri = 'https://scene-relay.test/callback';
const now = 1_000_000;
const pending = () => ({ state, clientId, redirectUri, createdAt: now });
const fragment = (overrides = {}) => '#' + new URLSearchParams({ access_token: token, state, scope: OAUTH_SCOPE, token_type: 'bearer', ...overrides });
function rejectsWithoutToken(value, metadata = pending(), options = { now }) {
  assert.throws(() => consumeOAuthFragment(value, metadata, options), error => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(token), 'errors must not contain the token');
    return true;
  });
}

test('callback construction retains only origin and path', () => {
  assert.equal(callbackURL('https://scene-relay.test:8443/path/callback?x=1#secret'), 'https://scene-relay.test:8443/path/callback');
  assert.equal(callbackURL('http://localhost:4178/callback'), 'http://localhost:4178/callback');
  assert.equal(callbackURL('http://127.0.0.1:4178/'), 'http://127.0.0.1:4178/');
  assert.equal(callbackURL('http://[::1]:4178/'), 'http://[::1]:4178/');
});

test('callbacks reject credentials and insecure remote or non-web schemes', () => {
  for (const url of ['http://remote.test/callback', 'https://user:password@scene-relay.test/', 'javascript:alert(1)', 'data:text/html,test', 'file:///tmp/app', 'wss://scene-relay.test/', 'http://localhost.evil.test/', 'not a URL']) {
    assert.throws(() => callbackURL(url));
  }
});

test('OAuth cleanup removes the entire fragment without altering the callback path', () => {
  const cleaned = stripOAuthURL(`${redirectUri}?view=operator${fragment()}`);
  assert.equal(cleaned, `${redirectUri}?view=operator`);
  assert.ok(!cleaned.includes(token));
});

test('nonce generation uses 32 cryptographic bytes and has no weak fallback', () => {
  let requestedBytes = 0;
  const nonce = createNonce({ getRandomValues(bytes) { requestedBytes = bytes.length; bytes.fill(0xab); return bytes; } });
  assert.equal(requestedBytes, 32);
  assert.equal(nonce, 'ab'.repeat(32));
  assert.match(nonce, /^[a-f0-9]{64}$/);
  assert.throws(() => createNonce({}));
  assert.throws(() => createNonce(null));
});

test('authorization URL has the official host and only read-only chat scope', () => {
  const url = new URL(makeOAuthURL({ clientId, redirectUri, state }));
  assert.equal(url.origin, 'https://id.twitch.tv');
  assert.equal(url.pathname, '/oauth2/authorize');
  assert.equal(url.searchParams.get('response_type'), 'token');
  assert.equal(url.searchParams.get('client_id'), clientId);
  assert.equal(url.searchParams.get('redirect_uri'), redirectUri);
  assert.equal(url.searchParams.get('scope'), 'user:read:chat');
  assert.equal(url.searchParams.get('state'), state);
  assert.equal(url.searchParams.has('client_secret'), false);
});

test('authorization URL rejects invalid metadata and ambiguous callback URLs', () => {
  for (const fields of [
    { clientId:'short' }, { clientId:'public-client-id-with-hyphens' }, { state:'weak' },
    { redirectUri:redirectUri+'?return=somewhere' }, { redirectUri:redirectUri+'#fragment' },
    { redirectUri:'https://user:password@scene-relay.test/callback' }
  ]) assert.throws(() => makeOAuthURL({ clientId, redirectUri, state, ...fields }));
});

test('a verified callback returns only the expected credential and public metadata', () => {
  const result = consumeOAuthFragment(fragment(), pending(), { now });
  assert.deepEqual(result, { accessToken:token, clientId, redirectUri });
  assert.equal(consumeOAuthFragment('#ordinary-view-fragment', null, { now }), null);
  assert.equal(consumeOAuthFragment('', null, { now }), null);
});

test('missing, mismatched or malformed pending state rejects the callback', () => {
  rejectsWithoutToken(fragment(), null);
  rejectsWithoutToken(fragment({ state:'cd'.repeat(32) }));
  rejectsWithoutToken(fragment({ state:'' }));
  rejectsWithoutToken(fragment(), { ...pending(), clientId:'bad' });
  rejectsWithoutToken(fragment(), { ...pending(), redirectUri:redirectUri+'?bad=1' });
});

test('OAuth pending state has a bounded lifetime with limited future clock skew', () => {
  assert.equal(consumeOAuthFragment(fragment(), pending(), { now:now+600_000 }).accessToken, token);
  rejectsWithoutToken(fragment(), pending(), { now:now+600_001 });
  rejectsWithoutToken(fragment(), { ...pending(), createdAt:now+60_001 });
  rejectsWithoutToken(fragment(), { ...pending(), createdAt:NaN });
  rejectsWithoutToken(fragment(), pending(), { now:Infinity });
});

test('callbacks cannot silently widen or omit the granted permission', () => {
  for (const scope of ['', 'chat:read', 'user:read:chat user:write:chat', 'user:read:chat user:read:chat']) rejectsWithoutToken(fragment({ scope }));
  rejectsWithoutToken(fragment({ token_type:'mac' }));
});

test('duplicate OAuth parameters are rejected even when their values agree', () => {
  for (const [key, value] of Object.entries({ access_token:token, state, scope:OAUTH_SCOPE, token_type:'bearer' })) {
    rejectsWithoutToken(fragment() + '&' + new URLSearchParams({ [key]:value }));
  }
});

test('denials, malformed tokens and oversized input never echo secrets or provider descriptions', () => {
  const denial = '#' + new URLSearchParams({ error:'access_denied', state, error_description:token });
  rejectsWithoutToken(denial);
  rejectsWithoutToken(fragment({ access_token:'' }));
  rejectsWithoutToken(fragment({ access_token:'invalid token with spaces' }));
  rejectsWithoutToken(fragment({ access_token:'a'.repeat(2_049) }));
  rejectsWithoutToken('#access_token=' + 'a'.repeat(8_200));
});
