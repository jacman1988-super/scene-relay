import { SCENES, PollEngine, validateDuration } from './domain.mjs';
import { callbackURL, stripOAuthURL, makeOAuthURL, createNonce, consumeOAuthFragment, OAUTH_STORAGE_KEY } from './security.mjs';
import { TwitchConnection } from './twitch.mjs';
import { createSceneRenderer } from './scenes.mjs';

// Remove the OAuth fragment before DOM updates, validation requests or other work.
const incomingFragment = location.hash;
const incomingQuery = new URL(location.href).searchParams;
if (incomingFragment) history.replaceState(null, '', stripOAuthURL(location.href));
if (incomingQuery.has('error') || incomingQuery.has('access_token')) history.replaceState(null, '', callbackURL(location.href));

const $ = id => document.getElementById(id);
let engine = new PollEngine(), mode = 'practice', connectionState = 'disconnected', channel = null;
let previousScene = 'aurora', lastAnnouncedSeconds = -1;
const renderer = createSceneRenderer($('scene-canvas'));
const announce = message => { $('announcer').textContent = message; };
const scene = id => SCENES.find(value => value.id === id);
const formatTime = ms => `${Math.floor(Math.ceil(ms / 1000) / 60).toString().padStart(2, '0')}:${(Math.ceil(ms / 1000) % 60).toString().padStart(2, '0')}`;
function showError(message) { $('error-notice').textContent = message; $('error-notice').hidden = !message; }
function resultText(result) {
  if (!result) return 'Ready when you are. The most votes decides the next scene.';
  const name = scene(result.currentSceneId).name;
  if (result.reason === 'tie') return `It’s a tie. ${name} stays on screen — no tie-breaker surprises.`;
  if (result.reason === 'no-votes') return `No votes this round. ${name} stays on screen.`;
  if (result.reason === 'cancelled') return `Round cancelled. ${name} stays on screen; no result was applied.`;
  return `${scene(result.winnerId).name} wins with ${result.count} ${result.count === 1 ? 'vote' : 'votes'}. The community’s choice is on screen.`;
}
function finishResult(result) { if (result) { announce(resultText(result)); $('practice-feedback').textContent = 'Round complete. Start another to try a different result.'; } }
function render() {
  const poll = engine.snapshot();
  const liveReady = mode === 'twitch' && connectionState === 'connected';
  const current = scene(poll.currentSceneId);
  const isPractice = mode === 'practice';
  $('header-status').classList.toggle('connected', liveReady);
  $('header-status-text').textContent = isPractice ? 'Practice · offline' : liveReady ? 'Twitch · connected' : 'Twitch · offline';
  $('connect-top').textContent = liveReady ? 'Connection settings ↗' : 'Connect Twitch ↗';
  $('mode-notice').classList.toggle('live', liveReady);
  const modeParagraph = $('mode-notice').querySelector('p');
  const title = document.createElement('strong');
  title.textContent = isPractice ? 'Practice mode — simulated votes. ' : liveReady ? 'Live Twitch chat — real votes. ' : 'Twitch mode — not connected. ';
  const detail = document.createTextNode(isPractice ? 'Explore the controls below. This is not a live Twitch connection.' : liveReady ? 'Only commands from your own channel count. Start a round when your community is ready.' : 'Connect your own channel before starting a real voting round.');
  modeParagraph.replaceChildren(title, detail);
  $('stage-source').replaceChildren(Object.assign(document.createElement('span'), { ariaHidden: 'true' }), document.createTextNode(isPractice ? ' PRACTICE PREVIEW' : liveReady ? ' LIVE CHAT CONNECTED' : ' TWITCH OFFLINE'));
  $('practice-card').hidden = !isPractice; $('live-card').hidden = isPractice;
  $('live-state').textContent = connectionState.toUpperCase();
  $('channel-label').hidden = !channel;
  $('channel-label').textContent = channel ? `twitch.tv/${channel}` : '';
  $('disconnect').hidden = !['connected', 'connecting', 'reconnecting'].includes(connectionState);
  $('connect-panel').hidden = ['connected', 'connecting', 'reconnecting'].includes(connectionState);
  $('round-state').textContent = poll.active ? 'VOTING OPEN' : poll.lastResult ? 'ROUND CLOSED' : 'READY';
  $('round-state').classList.toggle('active', poll.active);
  $('timer-label').textContent = poll.active ? 'TIME TO CHOOSE' : 'ROUND LENGTH';
  let displayedDuration = 45000;
  try { displayedDuration = validateDuration($('duration').value) * 1000; } catch { /* keep a neutral display until corrected */ }
  $('timer').textContent = formatTime(poll.active ? poll.remainingMs : displayedDuration);
  $('timer-progress').style.transform = `scaleX(${poll.active ? poll.remainingMs / (poll.durationSeconds * 1000) : 1})`;
  $('duration').disabled = poll.active;
  $('start-round').hidden = poll.active; $('stop-round').hidden = !poll.active;
  $('start-round').disabled = !isPractice && !liveReady;
  $('start-round').textContent = isPractice ? 'Start a practice round →' : 'Start a Twitch round →';
  $('round-help').textContent = poll.active ? 'Viewers can change their vote until the round closes.' : isPractice ? 'Try a round before connecting. No Twitch account needed.' : liveReady ? 'Your channel is ready. Share the three commands with your viewers.' : 'Connect Twitch to enable real votes.';
  $('total-voters').textContent = poll.totalVoters;
  $('voter-word').textContent = poll.totalVoters === 1 ? 'voter' : 'voters';
  for (const value of SCENES) {
    const count = poll.counts[value.id];
    const percentage = poll.totalVoters ? Math.round(count / poll.totalVoters * 100) : 0;
    $(`count-${value.id}`).textContent = count;
    $(`percent-${value.id}`).textContent = `${percentage}%`;
    $(`bar-${value.id}`).style.width = `${percentage}%`;
    const row = $(`row-${value.id}`);
    row.setAttribute('aria-label', `${value.name}: ${count} ${count === 1 ? 'vote' : 'votes'}, ${percentage} percent`);
    const choice = document.querySelector(`.scene-card[data-scene="${value.id}"]`);
    choice.classList.toggle('selected', value.id === current.id);
    choice.querySelector('.current-label').hidden = value.id !== current.id;
  }
  $('result-text').textContent = poll.active ? `${isPractice ? 'Practice' : 'Twitch'} voting is open. Type !scene1, !scene2 or !scene3.` : resultText(poll.lastResult);
  $('stage-result').textContent = poll.active ? 'Voting is open · scene changes at the reveal' : poll.lastResult?.reason === 'winner' ? 'Chosen by this round’s voters' : 'Your current scene';
  $('scene-index').textContent = `SCENE ${String(SCENES.indexOf(current) + 1).padStart(2, '0')} / 03`;
  $('scene-title').textContent = current.name;
  $('scene-description').textContent = current.description;
  if (current.id !== previousScene) { renderer.setScene(current.id); previousScene = current.id; }
  $('scene-canvas').setAttribute('aria-label', `${current.name}: an original illustrated landscape. ${current.description}`);
  document.querySelectorAll('.practice-vote').forEach(button => { button.disabled = !isPractice || !poll.active; });
}

for (const value of SCENES) {
  const row = document.createElement('div'); row.className = 'result-row'; row.id = `row-${value.id}`; row.style.setProperty('--scene-color', value.color);
  const heading = document.createElement('div'); heading.className = 'result-row-heading';
  const label = document.createElement('span'); label.className = 'result-name';
  const dot = document.createElement('span'); dot.className = 'result-dot'; dot.setAttribute('aria-hidden', 'true');
  label.append(dot, document.createTextNode(value.name));
  const counts = document.createElement('span'); counts.className = 'result-count';
  const percent = document.createElement('span'); percent.id = `percent-${value.id}`;
  const count = document.createElement('strong'); count.id = `count-${value.id}`;
  counts.append(percent, count); heading.append(label, counts);
  const track = document.createElement('div'); track.className = 'vote-bar'; track.setAttribute('aria-hidden', 'true');
  const bar = document.createElement('span'); bar.id = `bar-${value.id}`; track.append(bar);
  row.append(heading, track); $('results').append(row);
}
const connection = new TwitchConnection({
  onStatus(status) {
    connectionState = status.state; channel = status.channel || null;
    $('connection-message').textContent = status.message;
    if (['reconnecting', 'disconnected', 'error'].includes(status.state) && mode === 'twitch') finishResult(engine.cancel());
    if (status.state === 'connected') {
      mode = 'twitch'; document.querySelector('input[name="source"][value="twitch"]').checked = true;
      showError(''); announce('Twitch connected. Read-only chat is ready; start a round to collect votes.');
    }
    if (status.state === 'error') { showError(status.message); announce(status.message); }
    render();
  },
  onVote(vote) {
    if (mode !== 'twitch' || connectionState !== 'connected') return;
    const result = engine.cast(vote);
    if (result.accepted) announce(`A Twitch viewer ${result.reason === 'changed' ? 'changed their vote to' : 'voted for'} ${scene(result.sceneId).name}.`);
    render();
  },
});

document.querySelectorAll('input[name="source"]').forEach(input => input.addEventListener('change', () => {
  finishResult(engine.cancel());
  engine = new PollEngine(engine.snapshot().currentSceneId);
  mode = input.value;
  if (mode === 'practice') connection.disconnect();
  showError(''); render();
  announce(mode === 'practice' ? 'Practice mode. All votes are simulated.' : 'Twitch mode. Connect your channel for real votes.');
}));
$('duration').addEventListener('input', () => { $('duration-error').hidden = true; $('duration').removeAttribute('aria-invalid'); render(); });
$('start-round').addEventListener('click', () => {
  if (mode === 'twitch' && connectionState !== 'connected') return;
  try {
    engine.start($('duration').value);
    lastAnnouncedSeconds = -1;
    $('duration-error').hidden = true; $('duration').removeAttribute('aria-invalid');
    $('practice-feedback').textContent = 'Choose a demo viewer and cast a simulated vote.';
    announce(`${mode === 'practice' ? 'Practice' : 'Twitch'} round opened. Vote using !scene1, !scene2 or !scene3.`);
    render(); $('stop-round').focus();
  } catch (error) { $('duration-error').textContent = error.message; $('duration-error').hidden = false; $('duration').setAttribute('aria-invalid', 'true'); $('duration').focus(); }
});
$('stop-round').addEventListener('click', () => { finishResult(engine.finish()); render(); $('start-round').focus(); });
document.querySelectorAll('.practice-vote').forEach(button => button.addEventListener('click', () => {
  if (mode !== 'practice') return;
  const result = engine.cast({ text: button.dataset.vote, userId: $('practice-voter').value, messageId: `practice-${createNonce().slice(0, 32)}` });
  const viewer = $('practice-voter').selectedOptions[0].textContent;
  const text = result.accepted ? `${viewer} ${result.reason === 'changed' ? 'changed their choice to' : 'chose'} ${scene(result.sceneId).name}.` : result.reason === 'unchanged' ? `${viewer} already chose that scene. Still one vote.` : 'The round is closed. Start another to add votes.';
  $('practice-feedback').textContent = text; announce(`Simulation. ${text}`); render();
}));
$('disconnect').addEventListener('click', () => { connection.disconnect(); announce('Disconnected from Twitch. The current scene is unchanged.'); });

function openConnectDialog() {
  $('connect-error').hidden = true;
  try { $('callback-url').textContent = callbackURL(location.href); } catch { $('callback-url').textContent = 'Serve this app on HTTPS, or localhost for development.'; }
  $('connect-dialog').showModal();
}
$('connect-top').addEventListener('click', openConnectDialog);
$('connect-panel').addEventListener('click', openConnectDialog);
document.querySelectorAll('.dialog-close').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$('privacy-button').addEventListener('click', () => $('privacy-dialog').showModal());
$('connect-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const pending = { clientId: $('client-id').value.trim(), redirectUri: callbackURL(location.href), state: createNonce(), createdAt: Date.now() };
    const url = makeOAuthURL(pending);
    sessionStorage.setItem(OAUTH_STORAGE_KEY, JSON.stringify(pending));
    location.assign(url);
  } catch (error) { $('connect-error').textContent = error.message; $('connect-error').hidden = false; $('client-id').focus(); }
});
$('pause-animation').addEventListener('click', () => { renderer.setPaused(!renderer.paused); updatePauseButton(); });
function updatePauseButton() {
  $('pause-animation').textContent = renderer.paused ? '▷' : 'Ⅱ';
  $('pause-animation').setAttribute('aria-label', renderer.paused ? 'Resume scene animation' : 'Pause scene animation');
  $('pause-animation').title = renderer.paused ? 'Resume scene animation' : 'Pause scene animation';
  $('pause-animation').setAttribute('aria-pressed', String(renderer.paused));
}
$('fullscreen').addEventListener('click', async () => { try { await $('scene-stage').requestFullscreen(); } catch { announce('Full-screen view is unavailable in this browser.'); } });
$('exit-fullscreen').addEventListener('click', () => document.exitFullscreen?.());
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) $('fullscreen').focus(); });
setInterval(() => {
  const result = engine.tick(); finishResult(result);
  const poll = engine.snapshot();
  const seconds = Math.ceil(poll.remainingMs / 1000);
  if (poll.active && seconds === 10 && lastAnnouncedSeconds !== 10) { announce('Ten seconds left to vote.'); lastAnnouncedSeconds = 10; }
  render();
}, 250);
window.addEventListener('pagehide', () => { connection.disconnect(); });
updatePauseButton(); render();

// The application, not automation or a user-visible field, consumes the OAuth response.
if (incomingFragment.includes('access_token=') || incomingFragment.includes('error=') || incomingQuery.has('error')) {
  let pending;
  try {
    pending = JSON.parse(sessionStorage.getItem(OAUTH_STORAGE_KEY) || 'null');
    sessionStorage.removeItem(OAUTH_STORAGE_KEY);
    if (incomingQuery.has('error')) throw new Error('Twitch authorization was not granted. Practice mode is still available.');
    const authorization = consumeOAuthFragment(incomingFragment, pending);
    if (authorization) {
      $('client-id').value = authorization.clientId;
      mode = 'twitch'; document.querySelector('input[name="source"][value="twitch"]').checked = true;
      connection.connect(authorization);
    }
  } catch (error) { showError(error.message); announce(error.message); }
}
