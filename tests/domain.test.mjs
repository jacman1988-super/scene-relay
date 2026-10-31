import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENES, parseVote, validateDuration, PollEngine } from '../dist/domain.mjs';

const start = 1_000_000;
const vote = (engine, userId, scene = 1, messageId = `message-${userId}`, now = start + 1) =>
  engine.cast({ userId, messageId, text: `!scene${scene}`, now });

test('only the three complete scene commands are interpreted as votes', () => {
  assert.deepEqual(SCENES.map(s => s.id), ['aurora', 'cove', 'ember']);
  assert.equal(parseVote(' !ScEnE2\n'), 'cove');
  assert.equal(parseVote('!scene1'), 'aurora');
  assert.equal(parseVote('!scene3'), 'ember');
  for (const text of ['!scene0', '!scene4', '!scene12', '!scene 1', '!scene1 extra', 'hello !scene1', '<img onerror=alert(1)>', '', null, 123]) {
    assert.equal(parseVote(text), null, `must not accept ${JSON.stringify(text)}`);
  }
  assert.equal(parseVote(' '.repeat(65) + '!scene1'), null);
});

test('duration bounds accept whole seconds and reject non-finite or fractional values', () => {
  for (const seconds of [10, 45, 300, '45']) assert.equal(validateDuration(seconds), Number(seconds));
  for (const seconds of [9, 301, 10.5, NaN, Infinity, '10.5', '45 seconds', '']) assert.throws(() => validateDuration(seconds));
});

test('starting a round gives a deterministic clock and zero counts', () => {
  const engine = new PollEngine('cove');
  const state = engine.start(45, start);
  assert.equal(state.active, true);
  assert.equal(state.remainingMs, 45_000);
  assert.equal(state.currentSceneId, 'cove');
  assert.deepEqual(state.counts, { aurora: 0, cove: 0, ember: 0 });
  assert.equal(state.totalVoters, 0);
  assert.throws(() => new PollEngine('unrecognized'));
  assert.throws(() => new PollEngine().start(45, NaN));
});

test('a viewer can change their choice without creating a second vote', () => {
  const engine = new PollEngine(); engine.start(45, start);
  assert.equal(vote(engine, 'viewer-one').reason, 'accepted');
  assert.equal(vote(engine, 'viewer-one', 2, 'message-2').reason, 'changed');
  assert.equal(vote(engine, 'viewer-one', 2, 'message-3').reason, 'unchanged');
  const state = engine.snapshot(start + 100);
  assert.equal(state.totalVoters, 1);
  assert.deepEqual(state.counts, { aurora: 0, cove: 1, ember: 0 });
});

test('redelivered message IDs cannot add a vote or change its original choice', () => {
  const engine = new PollEngine(); engine.start(45, start);
  assert.equal(vote(engine, 'viewer-one', 1, 'same-message').accepted, true);
  assert.equal(vote(engine, 'viewer-two', 3, 'same-message').reason, 'duplicate');
  assert.equal(vote(engine, 'viewer-one', 2, 'same-message').reason, 'duplicate');
  assert.deepEqual(engine.snapshot(start).counts, { aurora: 1, cove: 0, ember: 0 });
});

test('an unchanged vote message is also deduplicated on redelivery', () => {
  const engine = new PollEngine(); engine.start(45, start);
  vote(engine, 'viewer-one', 1, 'first');
  assert.equal(vote(engine, 'viewer-one', 1, 'unchanged').reason, 'unchanged');
  assert.equal(vote(engine, 'viewer-two', 2, 'unchanged').reason, 'duplicate');
  assert.equal(engine.snapshot(start).totalVoters, 1);
});

test('bad identity, message and command inputs leave counts unchanged', () => {
  const engine = new PollEngine(); engine.start(45, start);
  assert.equal(engine.cast({ text: '!scene1', userId: '<viewer>', messageId: 'valid', now: start }).reason, 'invalid-user');
  assert.equal(engine.cast({ text: '!scene1', userId: 'valid', messageId: '../bad', now: start }).reason, 'invalid-message');
  assert.equal(engine.cast({ text: 'ordinary chat', userId: 'valid', messageId: 'valid', now: start }).reason, 'invalid-command');
  assert.equal(engine.snapshot(start).totalVoters, 0);
});

test('only votes strictly before the deadline can affect the result', () => {
  const engine = new PollEngine('cove'); engine.start(10, start);
  assert.equal(vote(engine, 'last-valid', 3, 'before', start + 9_999).accepted, true);
  assert.equal(engine.tick(start + 9_999), null);
  assert.equal(vote(engine, 'too-late', 1, 'at-deadline', start + 10_000).reason, 'late');
  const state = engine.snapshot(start + 10_000);
  assert.equal(state.active, false);
  assert.equal(state.currentSceneId, 'ember');
  assert.equal(state.lastResult.totalVotes, 1);
  assert.equal(state.remainingMs, 0);
  assert.equal(engine.tick(start + 20_000), null);
  assert.equal(vote(engine, 'closed-user').reason, 'closed');
});

test('a unique winning choice changes the scene and reports unique voter totals', () => {
  const engine = new PollEngine(); engine.start(45, start);
  vote(engine, 'one', 2); vote(engine, 'two', 2); vote(engine, 'three', 3);
  const result = engine.finish(start + 500);
  assert.equal(result.reason, 'winner');
  assert.equal(result.winnerId, 'cove');
  assert.equal(result.count, 2);
  assert.equal(result.totalVotes, 3);
  assert.equal(engine.snapshot(start).currentSceneId, 'cove');
  assert.equal(engine.finish(start + 600), null);
});

test('ties and rounds without votes retain the current scene', () => {
  const engine = new PollEngine('ember'); engine.start(45, start);
  vote(engine, 'one', 1); vote(engine, 'two', 2);
  assert.equal(engine.finish(start + 50).reason, 'tie');
  assert.equal(engine.snapshot(start).currentSceneId, 'ember');
  engine.start(45, start + 100);
  assert.equal(engine.finish(start + 200).reason, 'no-votes');
  assert.equal(engine.snapshot(start).currentSceneId, 'ember');
});

test('cancelling does not apply a leading scene', () => {
  const engine = new PollEngine('aurora'); engine.start(45, start);
  vote(engine, 'one', 3); vote(engine, 'two', 3);
  assert.equal(engine.cancel().reason, 'cancelled');
  assert.equal(engine.snapshot(start).currentSceneId, 'aurora');
  assert.equal(engine.snapshot(start).active, false);
  assert.equal(engine.cancel(), null);
});

test('an overlapping start is rejected without clearing the current round', () => {
  const engine = new PollEngine(); engine.start(45, start); vote(engine, 'one', 2);
  assert.throws(() => engine.start(10, start + 10));
  assert.equal(engine.snapshot(start).totalVoters, 1);
  assert.equal(engine.snapshot(start).durationSeconds, 45);
});

test('a fresh round clears prior votes and message deduplication', () => {
  const engine = new PollEngine(); engine.start(10, start); vote(engine, 'one', 2, 'reused');
  engine.finish(start + 10_000); engine.start(10, start + 20_000);
  assert.equal(engine.snapshot(start + 20_000).totalVoters, 0);
  assert.equal(vote(engine, 'one', 3, 'reused', start + 20_001).accepted, true);
});

test('snapshots and result objects cannot mutate engine state or disclose chat IDs', () => {
  const engine = new PollEngine(); engine.start(45, start);
  vote(engine, 'private-viewer-731', 2, 'private-message-904');
  const snapshot = engine.snapshot(start);
  snapshot.counts.cove = 900;
  const result = engine.finish(start + 10); result.currentSceneId = 'ember';
  const second = engine.snapshot(start);
  second.lastResult.reason = 'tampered';
  assert.equal(engine.snapshot(start).counts.cove, 1);
  assert.equal(engine.snapshot(start).currentSceneId, 'cove');
  assert.equal(engine.snapshot(start).lastResult.reason, 'winner');
  assert.doesNotMatch(JSON.stringify(engine.snapshot(start)), /private-viewer|private-message/);
});

test('counts match an independent last-choice-per-viewer model across many changes', () => {
  const engine = new PollEngine(); engine.start(300, start);
  const reference = new Map();
  for (let index = 0; index < 1_000; index++) {
    const user = `viewer-${index % 97}`;
    const choice = (index * 7 + Math.floor(index / 97)) % 3;
    vote(engine, user, choice + 1, `message-${index}`, start + index);
    reference.set(user, SCENES[choice].id);
  }
  const counts = { aurora: 0, cove: 0, ember: 0 };
  for (const scene of reference.values()) counts[scene]++;
  assert.deepEqual(engine.snapshot(start + 1_000).counts, counts);
  assert.equal(engine.snapshot(start).totalVoters, reference.size);
});

test('the bounded viewer limit rejects new viewers while allowing existing voters to change', () => {
  const engine = new PollEngine(); engine.start(300, start);
  for (let index = 0; index < 5_000; index++) assert.equal(vote(engine, `viewer-${index}`).accepted, true);
  assert.equal(vote(engine, 'viewer-extra').reason, 'capacity');
  assert.equal(vote(engine, 'viewer-0', 2, 'changed-at-capacity').reason, 'changed');
  assert.equal(engine.snapshot(start).totalVoters, 5_000);
});
