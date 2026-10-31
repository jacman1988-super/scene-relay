export const SCENES = Object.freeze([
  Object.freeze({ id: 'aurora', name: 'Aurora', command: '!scene1', color: '#a4f4d3', description: 'A little room to wonder.' }),
  Object.freeze({ id: 'cove', name: 'Coral Cove', command: '!scene2', color: '#ffb99c', description: 'Follow the gentler current.' }),
  Object.freeze({ id: 'ember', name: 'Ember Grove', command: '!scene3', color: '#f4d278', description: 'Stay for the last light.' }),
]);
const ids = SCENES.map(scene => scene.id);

export function parseVote(text) {
  if (typeof text !== 'string' || text.length > 64) return null;
  const match = /^!scene([123])$/i.exec(text.trim());
  return match ? ids[Number(match[1]) - 1] : null;
}

export function validateDuration(value) {
  if (typeof value === 'string' && !/^\d+$/.test(value)) throw new Error('Choose a whole number of seconds from 10 to 300.');
  const number = Number(value);
  if (!Number.isInteger(number) || number < 10 || number > 300) throw new Error('Choose a whole number of seconds from 10 to 300.');
  return number;
}

export class PollEngine {
  #votes = new Map();
  #seen = new Set();
  #active = false;
  #endsAt = 0;
  #duration = 45;
  #scene;
  #result = null;
  constructor(currentSceneId = 'aurora') {
    if (!ids.includes(currentSceneId)) throw new Error('Unknown scene.');
    this.#scene = currentSceneId;
  }
  start(durationSeconds = 45, now = Date.now()) {
    if (this.#active) throw new Error('Finish the current round first.');
    if (!Number.isFinite(now)) throw new Error('Invalid clock.');
    this.#duration = validateDuration(durationSeconds);
    this.#votes.clear(); this.#seen.clear(); this.#result = null;
    this.#active = true; this.#endsAt = now + this.#duration * 1000;
    return this.snapshot(now);
  }
  cast({ text, userId, messageId, now = Date.now() } = {}) {
    if (!Number.isFinite(now)) return { accepted: false, reason: 'late' };
    const wasActive = this.#active;
    this.tick(now);
    if (!this.#active) return { accepted: false, reason: wasActive ? 'late' : 'closed' };
    const sceneId = parseVote(text);
    if (!sceneId) return { accepted: false, reason: 'invalid-command' };
    if (typeof userId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) return { accepted: false, reason: 'invalid-user' };
    if (typeof messageId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(messageId)) return { accepted: false, reason: 'invalid-message' };
    if (this.#seen.has(messageId)) return { accepted: false, reason: 'duplicate' };
    // A bounded round avoids accumulating arbitrary chat content or identities.
    if (this.#seen.size >= 20000 || (!this.#votes.has(userId) && this.#votes.size >= 5000)) return { accepted: false, reason: 'capacity' };
    this.#seen.add(messageId);
    const previous = this.#votes.get(userId);
    if (previous === sceneId) return { accepted: false, reason: 'unchanged', sceneId };
    this.#votes.set(userId, sceneId);
    return { accepted: true, reason: previous ? 'changed' : 'accepted', sceneId };
  }
  tick(now = Date.now()) {
    return this.#active && Number.isFinite(now) && now >= this.#endsAt ? this.finish(now) : null;
  }
  finish(now = Date.now()) {
    if (!this.#active) return null;
    this.#active = false;
    const counts = this.#counts();
    const highest = Math.max(...Object.values(counts));
    const leaders = ids.filter(id => counts[id] === highest);
    const reason = highest === 0 ? 'no-votes' : leaders.length > 1 ? 'tie' : 'winner';
    const winnerId = reason === 'winner' ? leaders[0] : null;
    if (winnerId) this.#scene = winnerId;
    this.#result = { reason, winnerId, count: highest, totalVotes: this.#votes.size, endedAt: now, currentSceneId: this.#scene };
    return { ...this.#result };
  }
  cancel() {
    if (!this.#active) return null;
    this.#active = false;
    this.#result = { reason: 'cancelled', winnerId: null, count: 0, totalVotes: this.#votes.size, currentSceneId: this.#scene };
    return { ...this.#result };
  }
  #counts() {
    const counts = Object.fromEntries(ids.map(id => [id, 0]));
    for (const id of this.#votes.values()) counts[id] += 1;
    return counts;
  }
  snapshot(now = Date.now()) {
    return { active: this.#active, remainingMs: this.#active ? Math.max(0, this.#endsAt - now) : 0,
      durationSeconds: this.#duration, counts: this.#counts(), totalVoters: this.#votes.size,
      currentSceneId: this.#scene, lastResult: this.#result ? { ...this.#result } : null };
  }
}
