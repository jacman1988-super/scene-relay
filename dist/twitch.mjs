import { isTwitchReconnectURL, OAUTH_SCOPE } from './security.mjs';

// This transport never exposes access tokens, stores chat content, or sends chat.
export class TwitchConnection {
  #token = null; #client = null; #user = null; #socket = null;
  #sockets = new Set(); #keepalive = 10;
  #generation = 0; #retries = 0; #retryTimer = null; #watchdog = null; #validationTimer = null;
  constructor({ onStatus = () => {}, onVote = () => {} } = {}) { this.onStatus = onStatus; this.onVote = onVote; }
  async connect({ accessToken, clientId }) {
    this.disconnect(false);
    const generation = this.#generation;
    this.#token = accessToken; this.#client = clientId;
    this.onStatus({ state: 'connecting', message: 'Checking read-only Twitch access…' });
    try {
      const identity = await this.#validate();
      if (generation !== this.#generation) return;
      this.#user = identity;
      this.#open('wss://eventsub.wss.twitch.tv/ws', false, generation);
      this.#validationTimer = setInterval(async () => {
        try { await this.#validate(); } catch { if (generation === this.#generation) this.#fatal('Twitch authorization expired. Connect again to continue.'); }
      }, 25 * 60 * 1000);
    } catch { if (generation === this.#generation) this.#fatal('Twitch access could not be verified. Check the Client ID and connect again.'); }
  }
  async #validate() {
    const response = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${this.#token}` }, cache: 'no-store', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error('Authorization unavailable.');
    const value = await response.json();
    if (value.client_id !== this.#client || !/^\d{1,32}$/.test(value.user_id || '') || !/^[a-z0-9_]{1,25}$/i.test(value.login || '') || !Array.isArray(value.scopes) || value.scopes.length !== 1 || value.scopes[0] !== OAUTH_SCOPE || !(value.expires_in > 0)) throw new Error('Unexpected authorization.');
    return { id: value.user_id, login: value.login };
  }
  #open(url, handover, generation) {
    if (generation !== this.#generation) return;
    const previous = this.#socket;
    let socket;
    try { socket = new WebSocket(url); } catch { this.#retry(generation); return; }
    this.#sockets.add(socket);
    if (!handover) this.#socket = socket;
    let welcomed = false;
    const welcomeTimer = setTimeout(() => {
      if (!welcomed) {
        socket.close();
        // If a handover fails, close the old tracked session as well; its
        // close handler is the single retry path. Never strand either socket.
        if (handover && generation === this.#generation) previous?.close();
      }
    }, 12000);
    socket.addEventListener('message', async event => {
      if (generation !== this.#generation || typeof event.data !== 'string' || event.data.length > 1000000) return;
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      const type = data?.metadata?.message_type;
      const session = data?.payload?.session;
      if (type === 'session_welcome') {
        welcomed = true; clearTimeout(welcomeTimer);
        if (!handover && socket !== this.#socket) { socket.close(); return; }
        if (!session || typeof session.id !== 'string') { socket.close(); return; }
        if (handover) { this.#socket = socket; previous?.close(); }
        try {
          if (!handover) await this.#subscribe(session.id);
          if (generation !== this.#generation || socket !== this.#socket) { socket.close(); return; }
          this.#retries = 0;
          this.#keepalive = Math.min(Math.max(Number(session.keepalive_timeout_seconds) || 10, 10), 600);
          this.#armWatchdog(this.#keepalive, generation);
          this.onStatus({ state: 'connected', message: 'Reading your channel’s chat. No messages are sent.', channel: this.#user.login });
        } catch { if (generation === this.#generation) this.#fatal('Chat subscription failed. Confirm read-only chat access and reconnect.'); }
      } else if (socket === this.#socket && type === 'session_reconnect') {
        if (!isTwitchReconnectURL(session?.reconnect_url)) { this.#fatal('Twitch supplied an unexpected reconnect address. Please connect again.'); return; }
        this.onStatus({ state: 'reconnecting', message: 'Twitch is moving the connection. The current round is cancelled.' });
        this.#open(session.reconnect_url, true, generation);
      } else if (socket === this.#socket && type === 'revocation') {
        this.#fatal('Twitch revoked chat access. Connect again when you are ready.');
      } else if (socket === this.#socket && type === 'notification') {
        this.#armWatchdog(this.#keepalive, generation);
        const subscription = data?.payload?.subscription;
        const value = data?.payload?.event;
        if (subscription?.type !== 'channel.chat.message' || value?.broadcaster_user_id !== this.#user?.id) return;
        if (value.source_broadcaster_user_id && value.source_broadcaster_user_id !== this.#user.id) return;
        this.onVote({ text: value.message?.text, userId: value.chatter_user_id, messageId: value.message_id, now: Date.now() });
      } else if (socket === this.#socket && type === 'session_keepalive') this.#armWatchdog(this.#keepalive, generation);
    });
    socket.addEventListener('close', () => { this.#sockets.delete(socket); clearTimeout(welcomeTimer); if (generation === this.#generation && socket === this.#socket) this.#retry(generation); });
    socket.addEventListener('error', () => { /* close is the single retry path */ });
  }
  async #subscribe(sessionId) {
    const response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${this.#token}`, 'Client-Id': this.#client, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: this.#user.id, user_id: this.#user.id }, transport: { method: 'websocket', session_id: sessionId } }),
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw new Error('Subscription unavailable.');
    const body = await response.json();
    if (body.data?.[0]?.status !== 'enabled') throw new Error('Subscription not enabled.');
  }
  #armWatchdog(seconds, generation) {
    clearTimeout(this.#watchdog);
    this.#watchdog = setTimeout(() => { if (generation === this.#generation) this.#socket?.close(); }, (Math.min(Math.max(seconds, 10), 600) + 5) * 1000);
  }
  #retry(generation) {
    if (generation !== this.#generation || !this.#token) return;
    clearTimeout(this.#watchdog); clearTimeout(this.#retryTimer);
    if (this.#retries >= 3) { this.#fatal('Twitch connection was lost. Connect again; no round result was applied.'); return; }
    this.onStatus({ state: 'reconnecting', message: 'Connection interrupted. Current round cancelled; reconnecting…' });
    const delay = [1000, 3000, 7000][this.#retries++];
    this.#retryTimer = setTimeout(() => this.#open('wss://eventsub.wss.twitch.tv/ws', false, generation), delay);
  }
  #fatal(message) { this.disconnect(false); this.onStatus({ state: 'error', message }); }
  disconnect(notify = true) {
    this.#generation++;
    clearTimeout(this.#watchdog); clearTimeout(this.#retryTimer); clearInterval(this.#validationTimer);
    for (const socket of this.#sockets) socket.close();
    this.#sockets.clear(); this.#socket = null;
    this.#token = null; this.#client = null; this.#user = null; this.#retries = 0;
    if (notify) this.onStatus({ state: 'disconnected', message: 'Disconnected. Chat access is no longer in use.' });
  }
}
