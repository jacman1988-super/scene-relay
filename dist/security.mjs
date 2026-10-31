export const OAUTH_SCOPE = 'user:read:chat';
export const OAUTH_STORAGE_KEY = 'scene-relay:oauth-pending';
const fail = message => { throw new Error(message); };

export function callbackURL(input) {
  let url;
  try { url = new URL(input); } catch { fail('Invalid callback URL.'); }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) fail('Use HTTPS, or a local development address.');
  return url.origin + url.pathname;
}
export function stripOAuthURL(input) {
  const url = new URL(input);
  url.hash = '';
  return url.toString();
}
export function isTwitchReconnectURL(input) {
  try {
    const url = new URL(input);
    return url.protocol === 'wss:' && url.hostname === 'eventsub.wss.twitch.tv' && url.pathname === '/ws' && !url.username && !url.password && !url.hash && (!url.port || url.port === '443');
  } catch { return false; }
}
export function createNonce(cryptoProvider = globalThis.crypto) {
  if (!cryptoProvider?.getRandomValues) fail('Secure browser randomness is unavailable.');
  return Array.from(cryptoProvider.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function makeOAuthURL({ clientId, redirectUri, state } = {}) {
  if (typeof clientId !== 'string' || !/^[A-Za-z0-9]{10,100}$/.test(clientId)) fail('Enter the public Client ID from your own Twitch application.');
  if (typeof state !== 'string' || !/^[A-Fa-f0-9]{64}$/.test(state)) fail('Invalid authorization state.');
  const redirect = callbackURL(redirectUri);
  if (redirect !== redirectUri) fail('Use the exact callback URL without a query or fragment.');
  const url = new URL('https://id.twitch.tv/oauth2/authorize');
  url.search = new URLSearchParams({ response_type: 'token', client_id: clientId, redirect_uri: redirect, scope: OAUTH_SCOPE, state }).toString();
  return url.toString();
}
export function consumeOAuthFragment(fragment, pending, { now = Date.now() } = {}) {
  if (typeof fragment !== 'string' || fragment.length > 8192) fail('Invalid authorization response.');
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  if (!params.has('access_token') && !params.has('error')) return null;
  for (const key of ['access_token', 'state', 'scope', 'token_type', 'error']) if (params.getAll(key).length > 1) fail('Ambiguous authorization response.');
  if (!pending || typeof pending.state !== 'string' || params.get('state') !== pending.state) fail('Authorization could not be verified. Please connect again.');
  if (!Number.isFinite(pending.createdAt) || !Number.isFinite(now) || now - pending.createdAt > 600000 || pending.createdAt - now > 60000) fail('Authorization expired. Please connect again.');
  if (params.has('error')) fail('Twitch authorization was not granted. You can keep using practice mode.');
  const accessToken = params.get('access_token');
  if (!accessToken || accessToken.length < 10 || accessToken.length > 2048 || !/^[A-Za-z0-9\-._~+/]+=*$/.test(accessToken)) fail('Invalid authorization response.');
  if (params.get('token_type')?.toLowerCase() !== 'bearer') fail('Unsupported authorization response.');
  const scopes = (params.get('scope') || '').split(/\s+/).filter(Boolean);
  if (scopes.length !== 1 || scopes[0] !== OAUTH_SCOPE) fail('This app needs only read-only Twitch chat access. Please reconnect with that permission.');
  // Re-validate public metadata without including any token in errors.
  makeOAuthURL(pending);
  return { accessToken, clientId: pending.clientId, redirectUri: pending.redirectUri };
}
