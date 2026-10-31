import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TwitchConnection } from '../dist/twitch.mjs';
import { PollEngine } from '../dist/domain.mjs';
import { isTwitchReconnectURL } from '../dist/security.mjs';

// All fetches, sockets and timers are replaced. These synthetic fixtures never
// contact Twitch or use real credentials, accounts, chat or wall-clock waits.
const TOKEN = 'SyntheticLocalTransportToken0123456789';
const CLIENT = 'SyntheticPublicClient12345';
const USER = '12345';
const welcome = id => ({ metadata:{message_type:'session_welcome'}, payload:{session:{id,keepalive_timeout_seconds:10}} });
const reconnect = url => ({ metadata:{message_type:'session_reconnect'}, payload:{session:{reconnect_url:url}} });
const response = (body, ok = true) => ({ok,json:async()=>body});
const deferred = () => { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve}; };
const flush = async () => { for (let i=0;i<6;i++) await Promise.resolve(); };
function notification({broadcaster=USER,source=null,type='channel.chat.message',messageId='chat-message-1',userId='67890',text='!scene2'}={}) {
  return {metadata:{message_type:'notification',message_id:'delivery-1'},payload:{subscription:{type},event:{broadcaster_user_id:broadcaster,source_broadcaster_user_id:source,message_id:messageId,chatter_user_id:userId,message:{text}}}};
}

async function harness(run, {validate,subscribe,onVote}={}) {
  const saved = Object.fromEntries(['fetch','WebSocket','setTimeout','clearTimeout','setInterval','clearInterval'].map(k=>[k,globalThis[k]]));
  const sockets=[], requests=[], statuses=[], tasks=new Map(); let nextTimer=0;
  class FakeSocket {
    constructor(url) {this.url=url;this.closed=false;this.closeCalls=0;this.listeners=new Map();sockets.push(this);}
    addEventListener(type, listener) {if(!this.listeners.has(type))this.listeners.set(type,[]);this.listeners.get(type).push(listener);}
    async emit(type, event={}) {for(const listener of this.listeners.get(type)||[]) await listener(event);}
    message(value) {return this.emit('message',{data:typeof value==='string'?value:JSON.stringify(value)});}
    close() {this.closeCalls++;if(this.closed)return;this.closed=true;queueMicrotask(()=>{void this.emit('close');});}
    async serverClose() {if(this.closed)return;this.closed=true;await this.emit('close');}
  }
  const schedule=(callback,delay,interval=false)=>{const id=++nextTimer;tasks.set(id,{callback,delay,interval});return id;};
  const identity=()=>({client_id:CLIENT,user_id:USER,login:'synthetic_channel',scopes:['user:read:chat'],expires_in:3600});
  globalThis.WebSocket=FakeSocket;
  globalThis.fetch=async(url,options={})=>{
    requests.push({url,options});
    if(url==='https://id.twitch.tv/oauth2/validate') return validate?validate(url,options):response(identity());
    if(url==='https://api.twitch.tv/helix/eventsub/subscriptions') return subscribe?subscribe(url,options):response({data:[{status:'enabled'}]});
    throw new Error('Unexpected network destination in local test.');
  };
  globalThis.setTimeout=(callback,delay)=>schedule(callback,delay);
  globalThis.setInterval=(callback,delay)=>schedule(callback,delay,true);
  globalThis.clearTimeout=globalThis.clearInterval=id=>tasks.delete(id);
  const connection=new TwitchConnection({onStatus:value=>statuses.push(value),onVote:onVote||(()=>{})});
  const env={connection,sockets,requests,statuses,tasks,
    connect:()=>connection.connect({accessToken:TOKEN,clientId:CLIENT}),
    async fireDelay(delay) {
      const entry=[...tasks].find(([,task])=>!task.interval&&task.delay===delay);
      assert.ok(entry,`Expected a pending ${delay}ms timeout`);
      tasks.delete(entry[0]);await entry[1].callback();await flush();
    }
  };
  try {await run(env);} finally {connection.disconnect(false);await flush();Object.assign(globalThis,saved);}
}

test('connect validates read-only identity and creates the exact own-channel subscription', async()=>{
  await harness(async h=>{
    await h.connect();assert.equal(h.sockets.length,1);
    assert.equal(h.sockets[0].url,'wss://eventsub.wss.twitch.tv/ws');
    await h.sockets[0].message(welcome('session-1'));
    const request=h.requests.find(r=>r.options.method==='POST');
    assert.deepEqual(JSON.parse(request.options.body),{type:'channel.chat.message',version:'1',condition:{broadcaster_user_id:USER,user_id:USER},transport:{method:'websocket',session_id:'session-1'}});
    assert.equal(request.options.headers.Authorization,`Bearer ${TOKEN}`);
    assert.equal(request.options.headers['Client-Id'],CLIENT);
    assert.equal(h.statuses.at(-1).state,'connected');
    assert.ok(!JSON.stringify(h.statuses).includes(TOKEN));
    assert.equal(h.requests.length,2);
  });
});

test('invalid identity fails closed without opening a WebSocket', async()=>{
  await harness(async h=>{await h.connect();assert.equal(h.sockets.length,0);assert.equal(h.statuses.at(-1).state,'error');assert.ok(!JSON.stringify(h.statuses).includes(TOKEN));},
    {validate:()=>response({client_id:CLIENT,user_id:USER,login:'synthetic_channel',scopes:['user:read:chat','user:write:chat'],expires_in:3600})});
});

test('subscription HTTP failure and non-enabled result never announce connected', async()=>{
  for(const result of [response({message:TOKEN},false),response({data:[{status:'websocket_disconnected'}]})]) {
    await harness(async h=>{await h.connect();await h.sockets[0].message(welcome('session-1'));assert.equal(h.statuses.at(-1).state,'error');assert.equal(h.sockets[0].closed,true);assert.equal(h.statuses.some(s=>s.state==='connected'),false);assert.ok(!JSON.stringify(h.statuses).includes(TOKEN));}, {subscribe:()=>result});
  }
});

test('disconnect during identity validation prevents late socket creation', async()=>{
  const gate=deferred();
  await harness(async h=>{
    const connecting=h.connect();h.connection.disconnect();
    gate.resolve(response({client_id:CLIENT,user_id:USER,login:'synthetic_channel',scopes:['user:read:chat'],expires_in:3600}));
    await connecting;assert.equal(h.sockets.length,0);assert.equal(h.statuses.at(-1).state,'disconnected');
  }, {validate:()=>gate.promise});
});

test('late subscription completion and stale messages cannot revive a disconnected session', async()=>{
  const gate=deferred();const votes=[];
  await harness(async h=>{
    await h.connect();const socket=h.sockets[0];const subscribing=socket.message(welcome('session-1'));
    h.connection.disconnect();gate.resolve(response({data:[{status:'enabled'}]}));await subscribing;
    await socket.message(notification());
    assert.equal(votes.length,0);assert.equal(socket.closed,true);assert.equal(h.statuses.some(s=>s.state==='connected'),false);
  }, {subscribe:()=>gate.promise,onVote:v=>votes.push(v)});
});

test('only own-channel chat reaches voting and repeated delivery cannot create extra votes', async()=>{
  const engine=new PollEngine();engine.start(45,Date.now());const castResults=[];
  await harness(async h=>{
    await h.connect();const socket=h.sockets[0];await socket.message(welcome('session-1'));
    await socket.message(notification({broadcaster:'99999'}));
    await socket.message(notification({source:'99999'}));
    await socket.message(notification({type:'channel.follow'}));
    await socket.message('not JSON');
    assert.equal(castResults.length,0);
    await socket.message(notification());await socket.message(notification());
    assert.equal(castResults.filter(r=>r.accepted).length,1);
    assert.equal(engine.snapshot().totalVoters,1);
    assert.deepEqual(engine.snapshot().counts,{aurora:0,cove:1,ember:0});
  }, {onVote:value=>castResults.push(engine.cast(value))});
});

test('successful reconnect handover retires the old socket without creating another subscription', async()=>{
  const votes=[];
  await harness(async h=>{
    await h.connect();const first=h.sockets[0];await first.message(welcome('session-1'));
    await first.message(reconnect('wss://eventsub.wss.twitch.tv/ws?reconnect=synthetic'));
    const replacement=h.sockets[1];assert.equal(first.closed,false);
    await replacement.message(welcome('session-2'));await flush();
    assert.equal(first.closed,true);assert.equal(replacement.closed,false);
    assert.equal(h.requests.filter(r=>r.options.method==='POST').length,1);
    await first.message(notification());assert.equal(votes.length,0);
    await replacement.message(notification());assert.equal(votes.length,1);
  }, {onVote:value=>votes.push(value)});
});

test('disconnect also closes a pending handover socket immediately', async()=>{
  await harness(async h=>{
    await h.connect();const first=h.sockets[0];await first.message(welcome('session-1'));
    await first.message(reconnect('wss://eventsub.wss.twitch.tv/ws?reconnect=synthetic'));
    assert.equal(h.sockets.length,2);h.connection.disconnect();await flush();
    assert.ok(h.sockets.every(s=>s.closed),'all current and pending sockets must close on disconnect');
  });
});

test('failed handover fallback cannot leave the original socket untracked and open', async()=>{
  await harness(async h=>{
    await h.connect();const first=h.sockets[0];await first.message(welcome('session-1'));
    await first.message(reconnect('wss://eventsub.wss.twitch.tv/ws?reconnect=synthetic'));
    await h.fireDelay(12_000);
    // Retaining a healthy old connection or opening a fresh fallback are both
    // valid recovery strategies; either must remain completely disconnectable.
    if([...h.tasks.values()].some(t=>!t.interval&&t.delay===1_000)) {
      await h.fireDelay(1_000);
      const fallback=h.sockets.at(-1);
      if(!fallback.closed) await fallback.message(welcome('session-3'));
    }
    h.connection.disconnect();await flush();
    assert.ok(h.sockets.every(s=>s.closed),'fallback and disconnect must retire the original socket too');
  });
});

test('a missing welcome schedules one first retry rather than consuming two attempts', async()=>{
  await harness(async h=>{
    await h.connect();await h.fireDelay(12_000);
    const reconnectDelays=[...h.tasks.values()].filter(t=>!t.interval&&[1_000,3_000,7_000].includes(t.delay)).map(t=>t.delay);
    assert.deepEqual(reconnectDelays,[1_000]);
    await h.fireDelay(1_000);assert.equal(h.sockets.length,2);
  });
});

test('reconnect URLs cannot redirect the transport to another host or protocol', async()=>{
  for(const url of ['wss://eventsub.wss.twitch.tv/ws','wss://eventsub.wss.twitch.tv/ws?reconnect=synthetic','wss://eventsub.wss.twitch.tv:443/ws']) assert.equal(isTwitchReconnectURL(url),true);
  const invalid=['ws://eventsub.wss.twitch.tv/ws','wss://eventsub.wss.twitch.tv.evil.test/ws','wss://evil.test/ws','wss://token@eventsub.wss.twitch.tv/ws','wss://eventsub.wss.twitch.tv:444/ws','wss://eventsub.wss.twitch.tv/ws#token','wss://eventsub.wss.twitch.tv/ws/','not a URL'];
  for(const url of invalid) assert.equal(isTwitchReconnectURL(url),false,url);
  await harness(async h=>{
    await h.connect();await h.sockets[0].message(welcome('session-1'));
    await h.sockets[0].message(reconnect('wss://evil.test/ws'));
    assert.equal(h.sockets.length,1);assert.equal(h.sockets[0].closed,true);assert.equal(h.statuses.at(-1).state,'error');
  });
});
