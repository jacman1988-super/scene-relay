# Scene Relay

Viewers vote in Twitch chat; the result changes the illustrated scene on screen. Scene Relay is a small, static voting desk with three original browser-drawn worlds, clear counts and a separate, explicitly labelled practice mode.

Public demo: [Scene Relay](https://scene-relay-jacada-2026.adamekjacek.chatgpt.site/).

The public app and a real, single-account Twitch test have been verified. Two actual commands, `!scene1` followed by `!scene2`, moved one viewer's vote without increasing the voter total; closing the round selected Coral Cove on screen. This does not claim a multi-viewer live test, a contest submission or a prize.

## Run locally

No package installation or build is required. With Python 3:

```sh
python -m http.server 4173 --bind 127.0.0.1 --directory dist
```

Open `http://127.0.0.1:4173/`. Alternatively, run `npm run serve` where `python` is available. Any static HTTPS host can serve `dist/` as-is; do not open `index.html` through `file://`.

Run the dependency-free logic/security tests with Node.js 18 or later:

```sh
npm test
```

## Try a round

1. In **Practice**, choose 10–300 seconds and start a round.
2. Select a simulated viewer and press `!scene1`, `!scene2` or `!scene3`.
3. A viewer's latest valid command replaces their previous vote. Other viewers add separate votes.
4. Close the round or wait for its deadline. A unique winner selects that scene; a tie or no votes keeps the current scene with an explicit explanation.

Practice sends nothing to Twitch. It is not proof of a working Twitch integration. The full-screen button presents the app's own scene; Scene Relay does not control OBS or change a broadcaster's Twitch settings.

## Connect your own Twitch channel

1. On the public demo, choose **Connect Twitch**, continue with the prefilled public Client ID, and sign in to the Twitch account whose own channel you want to use. A separate developer application is not needed for this hosted demo.
2. Approve only `user:read:chat`. The supplied public Client ID is `pi4u5g91unuxs6hwubc6ojocerzyca`, registered for `https://scene-relay-jacada-2026.adamekjacek.chatgpt.site/`. It is public configuration, not a credential.
3. For local development or a different host, register your own Twitch application and replace the editable Client ID. App registration requires a verified email and 2FA. Register the exact redirect URL shown in the app; for local development it is `http://127.0.0.1:4173/`. Never enter a client secret or password.
4. The application validates the returned authorization and subscribes to `channel.chat.message` for the authenticated user's own channel using EventSub WebSocket. It never requests permission to send chat or moderate.
5. Start a Twitch round and enter a command in the real channel's Twitch chat. Each distinct viewer gets one changeable vote. Network interruption cancels an open round rather than applying an incomplete result; start a fresh round after reconnection.

No backend, secret, paid AI service, Twitch Extension or separate bot account is needed for this design. The public demo uses the already registered Scene Relay application; authorizing read-only access to your own account remains required. Other hosts need their own registered application/callback configuration. Practice does not bypass any authorization. Standard Twitch access and rate limits apply.

## Privacy and security

- Access tokens exist only in page memory. The OAuth fragment is removed before DOM updates or requests. A random 256-bit state value and public handoff configuration are held temporarily in session storage and removed on return.
- No analytics, application database, external fonts, chat history, identities or data exports. Temporary viewer/message IDs in page memory prevent double counting and reset with a new round.
- Only the authenticated broadcaster's channel is subscribed to. Shared-chat messages attributed to another source channel are ignored.
- OAuth validates state, age, exact scope, registered callback metadata and the account token. Reconnect URLs are restricted to Twitch's EventSub WebSocket host.
- Disconnecting or leaving the page stops the connection and clears its in-memory token. Reloading requires a new authorization handoff. Disconnect does not revoke a previously granted permission at Twitch; you can revoke it in Twitch account connections.
- A round is bounded to 5,000 viewers and 20,000 distinct valid command messages. Invalid commands and oversized input are ignored. Messages are rendered using text nodes, never as HTML.
- Keep passwords, access/refresh tokens, client secrets and raw OAuth callback addresses out of source, screenshots, logs and recordings. Client IDs are public configuration.

## What was made with Codex

The entrant explicitly chose a chat vote whose result changes the on-screen scene, with simple controls and a readable result. OpenAI Codex designed and implemented the application, original CSS/canvas scenes, Twitch integration, documentation and tests, with a separate Codex agent reviewing the pure logic, security helpers and transport races. This does not claim the entrant hand-wrote the code. The authorized real Twitch check was then performed separately from the simulated tests.

The browser has no model inference or generated-media API calls. All scene art is original procedural Canvas drawing. There are no third-party runtime dependencies or bundled media assets. The source is licensed under MIT; Twitch APIs and branding remain under Twitch's terms.

## Validation boundary

All 39 automated tests passed: voting, parsing, round timing, deduplication, OAuth/security helpers and transport tested with controlled WebSocket/fetch/timer stubs. Chrome practice workflows also passed. A separate real OAuth/EventSub check on the entrant's own channel received `!scene1` and then `!scene2` from the same account, kept one voter, and selected Coral Cove at the reveal.

That end-to-end check is deliberately narrow: one account/channel, not a many-viewer load test, cross-browser certification or accessibility certification. Practice remains clearly simulated. A recorded demo, accessible judging repository and official submission receipt are separate artifacts; none is implied by a working public app.

Official references: [contest requirements](https://twitchcon-codex.devpost.com/), [FAQ](https://twitchcon-codex.devpost.com/resources), [Twitch chat authentication](https://dev.twitch.tv/docs/chat/authenticating/), [implicit OAuth](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#implicit-grant-flow), [EventSub WebSockets](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/).
