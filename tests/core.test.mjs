import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCore, ensureAlarm, parseChannel, parseChannelList, parseTargetUrl, safeVerificationUri, tabMatcher, ALARM,
} from '../core.js';

const CID = 'abcdefghij0123456789abcdefghij';
const HOUR = 3600_000;

function area(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      const out = {};
      for (const k of [].concat(keys)) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(obj) { Object.assign(data, structuredClone(obj)); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
  };
}

function env({ local = {}, tabs = [], windows = [{ id: 1, focused: true, incognito: false }], routes } = {}) {
  const clock = { t: 1_000_000 };
  const calls = [];
  const fetched = [];
  const front = [];
  const played = [];
  const playResult = { value: true };
  const chrome = {
    storage: { local: area(local), session: area() },
    tabs: {
      query: async () => structuredClone(tabs),
      reload: async (id) => {
        if (!tabs.some((t) => t.id === id)) throw new Error('No tab');
        calls.push(['reload', id]);
      },
      create: async (p) => { calls.push(['create', p]); return { id: 100 + calls.length, windowId: p.windowId }; },
      update: async (id, p) => {
        if (!tabs.some((t) => t.id === id)) throw new Error('No tab');
        front.push(['tab', id, p]);
      },
      get: async (id) => ({ id, status: 'complete' }),
    },
    windows: {
      getAll: async () => structuredClone(windows),
      create: async (p) => { calls.push(['window', p]); return { tabs: [{ id: 200 }] }; },
      update: async (id, p) => { front.push(['window', id, p]); },
    },
    scripting: {
      executeScript: async (p) => { played.push(p); return [{ result: playResult.value }]; },
    },
    alarms: {
      list: {},
      async get(name) { return this.list[name]; },
      async create(name, info) { this.list[name] = info; calls.push(['alarm', name, info]); },
    },
  };
  const fetch = async (url, init = {}) => {
    fetched.push({ url, init });
    const r = await routes(url, init);
    if (r instanceof Error) throw r;
    return { status: r.status ?? 200, headers: new Headers(r.headers ?? {}), json: async () => r.body };
  };
  const core = createCore({ chrome, fetch, now: () => clock.t, sleep: async () => {} });
  return { core, chrome, clock, calls, fetched, front, played, playResult, local: chrome.storage.local.data, tabs };
}

const connected = (extra = {}) => ({
  settings: { clientId: CID, channels: [{ channel: 'somechan', targetUrl: '' }], enabled: true },
  auth: { clientId: CID, accessToken: 'AT-1', refreshToken: 'RT-1', expiresAt: 1_000_000 + 4 * HOUR, validatedAt: 1_000_000 },
  ...extra,
});
const live = (id) => ({ body: { data: [{ id, user_login: 'somechan', type: 'live' }] } });
const H = (id) => ({ handledStreams: { somechan: id } });
const offline = { body: { data: [] } };

test('開台時在背景開新分頁；同一場不重複，重啟後仍記得，新場次即使沒看到離線也觸發', async () => {
  let stream = live('111');
  const e = env({ local: connected(), routes: () => stream });
  await e.core.tick();
  assert.deepEqual(e.calls, [['create', { windowId: 1, url: 'https://www.twitch.tv/somechan', active: true }]]);
  assert.deepEqual(e.local.handledStreams, { somechan: '111' });
  await e.core.tick();
  assert.equal(e.calls.length, 1);

  const restarted = createCore({ chrome: e.chrome, fetch: async () => ({ status: 200, headers: new Headers(), json: async () => stream.body }), now: () => e.clock.t });
  await restarted.tick();
  assert.equal(e.calls.length, 1);

  stream = live('222');
  await e.core.tick();
  assert.equal(e.calls.length, 2);
  assert.deepEqual(e.local.handledStreams, { somechan: '222' });
});

test('已有相符分頁時只重新整理一個，略過無痕與正在導向別處的分頁', async () => {
  const tabs = [
    { id: 1, url: 'https://twitch.tv/SomeChan/?ref=x', lastAccessed: 5 },
    { id: 2, url: 'https://www.twitch.tv/somechan', lastAccessed: 9 },
    { id: 3, url: 'https://www.twitch.tv/somechan', incognito: true, lastAccessed: 99 },
    { id: 4, url: 'https://www.twitch.tv/somechan', pendingUrl: 'https://example.com/', lastAccessed: 50 },
    { id: 5, url: 'https://www.twitch.tv/somechan/videos' },
  ];
  const e = env({ local: connected(), tabs, routes: () => live('1') });
  await e.core.tick();
  assert.deepEqual(e.calls, [['reload', 2]]);
});

test('相符分頁在重新整理前消失時改為開新分頁', async () => {
  const e = env({ local: connected(), routes: () => live('1') });
  e.chrome.tabs.query = async () => [{ id: 7, url: 'https://www.twitch.tv/somechan' }];
  await e.core.tick();
  assert.deepEqual(e.calls.map((c) => c[0]), ['create']);
  assert.deepEqual(e.local.handledStreams, { somechan: '1' });
});

test('分頁動作失敗時不標記已處理，下次重試', async () => {
  const e = env({ local: connected(), routes: () => live('1') });
  e.chrome.windows.getAll = async () => { throw new Error('boom'); };
  await e.core.tick();
  assert.equal(e.local.handledStreams, undefined);
  assert.match(e.local.status.lastError, /somechan：.*分頁/);
});

test('API/網路/格式錯誤保留已處理狀態且不當作離線', async () => {
  const responses = [{ status: 500 }, new TypeError('offline'), { body: { nope: 1 } }, live('111')];
  const e = env({ local: connected(H('111')), routes: () => responses.shift() });
  for (let i = 0; i < 3; i++) {
    await e.core.tick();
    assert.deepEqual(e.local.handledStreams, { somechan: '111' });
    assert.ok(e.local.status.lastError);
    assert.ok(e.local.auth);
  }
  await e.core.tick();
  assert.equal(e.calls.length, 0);
  assert.equal(e.local.status.lastError, null);
});

test('429 依 Retry-After 冷卻，期間不再發請求', async () => {
  const e = env({ local: connected(), routes: () => ({ status: 429, headers: { 'Retry-After': '120' } }) });
  await e.core.tick();
  assert.equal(e.fetched.length, 1);
  e.clock.t += 60_000;
  await e.core.tick();
  assert.equal(e.fetched.length, 1);
  await assert.rejects(e.core.tick({ manual: true }), /暫緩/);
  e.clock.t += 61_000;
  await e.core.tick();
  assert.equal(e.fetched.length, 2);
});

test('429 冷卻完整遵守 Retry-After 3600 秒與 HTTP 日期，並取較晚的 Ratelimit-Reset', async () => {
  let headers = { 'Retry-After': '3600' };
  const e = env({ local: connected(), routes: () => ({ status: 429, headers }) });
  const start = e.clock.t;
  await e.core.tick();
  assert.equal(e.local.status.cooldownUntil, start + 3600_000);
  e.clock.t = start + 3599_000;
  await e.core.tick();
  assert.equal(e.fetched.length, 1);

  e.clock.t = start + 3600_000;
  headers = {
    'Retry-After': new Date(e.clock.t + 7200_000).toUTCString(),
    'Ratelimit-Reset': String((e.clock.t + 9000_000) / 1000),
  };
  await e.core.tick();
  assert.equal(e.local.status.cooldownUntil, e.clock.t + 9000_000);
});

test('Device Code 輪詢收到 429 後，冷卻期間不再送請求；重按連接也不送', async () => {
  const local = connected();
  delete local.auth;
  const e = env({
    local,
    routes: (url) => (url.endsWith('/device')
      ? { body: { device_code: 'DC', user_code: 'X', verification_uri: 'https://www.twitch.tv/activate', expires_in: 7200, interval: 5 } }
      : { status: 429, headers: { 'Retry-After': '3600' } }),
  });
  await e.core.authStart();
  e.clock.t += 5000;
  assert.equal((await e.core.authPoll()).state, 'pending');
  assert.equal(e.fetched.length, 2);
  for (const step of [6000, 60_000, 3000_000]) {
    e.clock.t += step;
    assert.equal((await e.core.authPoll()).state, 'pending');
  }
  await assert.rejects(e.core.authStart(), /暫緩/);
  assert.equal(e.fetched.length, 2);
  e.clock.t += 600_000;
  await e.core.authPoll();
  assert.equal(e.fetched.length, 3);
});

test('冷卻期間 Device Code 過期仍會結束等待', async () => {
  const local = connected();
  delete local.auth;
  const e = env({
    local,
    routes: (url) => (url.endsWith('/device')
      ? { body: { device_code: 'DC', user_code: 'X', verification_uri: 'https://www.twitch.tv/activate', expires_in: 60, interval: 5 } }
      : { status: 429, headers: { 'Retry-After': '3600' } }),
  });
  await e.core.authStart();
  e.clock.t += 5000;
  await e.core.authPoll();
  e.clock.t += 56_000;
  await assert.rejects(e.core.authPoll(), /過期/);
  assert.equal((await e.core.getState()).pending, null);
  assert.equal(e.fetched.length, 2);
});

test('401 時更新一次 token 並重試，儲存輪替後的 refresh token', async () => {
  const e = env({
    local: connected(),
    routes: (url, init) => {
      if (url.endsWith('/oauth2/token')) {
        assert.equal(init.body.get('grant_type'), 'refresh_token');
        assert.equal(init.body.get('client_secret'), null);
        return { body: { access_token: 'AT-2', refresh_token: 'RT-2', expires_in: 14000 } };
      }
      return init.headers.Authorization === 'Bearer AT-2' ? live('9') : { status: 401 };
    },
  });
  await e.core.tick();
  assert.equal(e.local.auth.refreshToken, 'RT-2');
  assert.equal(e.calls.length, 1);
});

test('refresh token 無效時清除授權、要求重新連接，之後不再送受保護請求', async () => {
  const e = env({
    local: connected(),
    routes: (url) => (url.endsWith('/token') ? { status: 400, body: { message: 'Invalid refresh token' } } : { status: 401 }),
  });
  await e.core.tick();
  assert.equal(e.local.auth, null);
  const state = await e.core.getState();
  assert.equal(state.connection, 'reconnect');
  const n = e.fetched.length;
  await e.core.tick();
  assert.equal(e.fetched.length, n);
});

test('更新 token 時遇到暫時性錯誤保留授權', async () => {
  const e = env({ local: connected(), routes: (url) => (url.endsWith('/token') ? { status: 503 } : { status: 401 }) });
  await e.core.tick();
  assert.equal(e.local.auth.refreshToken, 'RT-1');
  assert.match(e.local.status.lastError, /暫時/);
});

test('每小時驗證 token（監控關閉時也會），client_id 不符則清除授權', async () => {
  const local = connected();
  local.settings.enabled = false;
  const e = env({ local, routes: () => ({ body: { client_id: 'someoneelse', login: 'me', expires_in: 100 } }) });
  await e.core.tick();
  assert.equal(e.fetched.length, 0);
  e.clock.t += HOUR;
  await e.core.tick();
  assert.match(e.fetched[0].url, /oauth2\/validate$/);
  assert.equal(e.fetched[0].init.headers.Authorization, 'OAuth AT-1');
  assert.equal(e.local.auth, null);
  assert.equal((await e.core.getState()).connection, 'reconnect');
});

test('關閉監控不檢查；重新啟用時目前場次觸發一次', async () => {
  const e = env({ local: connected(H('5')), routes: () => live('5') });
  await e.core.saveSettings({ clientId: CID, channels: 'somechan', enabled: false });
  await e.core.tick();
  assert.equal(e.fetched.length, 0);
  await assert.rejects(e.core.tick({ manual: true }), /監控目前關閉/);
  await e.core.saveSettings({ clientId: CID, channels: 'somechan', enabled: true });
  await e.core.tick();
  assert.equal(e.calls.length, 1);
});

test('同時觸發多次檢查只動作一次', async () => {
  const e = env({ local: connected(), routes: () => live('1') });
  await Promise.all([e.core.tick(), e.core.tick({ manual: true }), e.core.tick()]);
  assert.equal(e.calls.length, 1);
});

test('檢查進行中變更設定時不執行過期的動作', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const e = env({ local: connected(), routes: async () => { await gate; return live('1'); } });
  const checking = e.core.tick();
  await new Promise((r) => setImmediate(r));
  const saving = e.core.saveSettings({ clientId: CID, channels: 'somechan', enabled: false });
  release();
  await Promise.all([checking, saving]);
  assert.equal(e.calls.length, 0);
  assert.deepEqual(e.local.handledStreams, {});
});

test('變更 Client ID 會清除舊授權；getState 不含 token', async () => {
  const e = env({ local: connected(), routes: () => offline });
  assert.ok(!JSON.stringify(await e.core.getState()).includes('AT-1'));
  await e.core.saveSettings({ clientId: 'zzzzzzzzzz0123456789', channels: 'https://www.twitch.tv/SomeChan', enabled: true });
  assert.equal(e.local.auth, null);
  assert.deepEqual(e.local.settings.channels, [{ channel: 'somechan', targetUrl: '' }]);
  await assert.rejects(e.core.saveSettings({ clientId: CID, channels: 'somechan javascript:alert(1)' }), /第 1 行格式/);
  await assert.rejects(e.core.saveSettings({ clientId: CID, channels: 'somechan https://user:pw@x.com' }), /第 1 行的目標網址/);
});

test('測試動作不需授權，也不改變已處理場次', async () => {
  const local = connected(H('42'));
  delete local.auth;
  local.settings.channels.push({ channel: 'other', targetUrl: 'https://example.com/page?x=1' });
  const e = env({ local, tabs: [{ id: 3, url: 'https://example.com/page?x=1#top' }], routes: () => { throw new Error('no fetch'); } });
  assert.equal(await e.core.testOpen('other'), '已重新整理既有分頁並切到該分頁');
  assert.equal(e.played.length, 0, '非 Twitch 網址不注入播放守護');
  assert.deepEqual(e.calls, [['reload', 3]]);
  assert.deepEqual(e.local.handledStreams, { somechan: '42' });
  assert.match(e.local.status.lastAction, /測試 other/);
});

test('Device Code Flow：驗證網址檢查、pending、slow_down、間隔與成功', async () => {
  let tokenReplies = [
    { status: 400, body: { status: 400, message: 'authorization_pending' } },
    { status: 400, body: { status: 400, message: 'slow_down' } },
    { body: { access_token: 'AT-9', refresh_token: 'RT-9', expires_in: 14000 } },
  ];
  let device = { device_code: 'DC', user_code: 'ABCD1234', verification_uri: 'https://evil.example/activate', expires_in: 1800, interval: 5 };
  const local = connected();
  delete local.auth;
  const e = env({
    local,
    routes: (url, init) => {
      if (url.endsWith('/device')) {
        assert.equal(init.body.get('scopes'), '');
        return { body: device };
      }
      if (url.endsWith('/validate')) return { body: { client_id: CID, login: 'viewer', expires_in: 14000 } };
      assert.equal(init.body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
      return tokenReplies.shift();
    },
  });
  await assert.rejects(e.core.authStart(), /格式異常/);
  device = { ...device, verification_uri: 'https://www.twitch.tv/activate?public=true&device-code=ABCD1234' };
  const started = await e.core.authStart();
  assert.equal(started.userCode, 'ABCD1234');
  assert.ok(!JSON.stringify(started).includes('DC'));

  assert.equal((await e.core.authPoll()).state, 'pending');
  const tokenCalls = () => e.fetched.filter((f) => f.url.endsWith('/token')).length;
  assert.equal(tokenCalls(), 0);
  e.clock.t += 5000;
  await e.core.authPoll();
  e.clock.t += 5000;
  assert.equal((await e.core.authPoll()).state, 'pending');
  assert.equal(tokenCalls(), 2);
  e.clock.t += 5000;
  await e.core.authPoll();
  assert.equal(tokenCalls(), 2, 'slow_down 後間隔加長');
  e.clock.t += 5000;
  assert.equal((await e.core.authPoll()).state, 'connected');
  const state = await e.core.getState();
  assert.equal(state.connection, 'connected');
  assert.equal(state.login, 'viewer');
  assert.equal(state.pending, null);
});

test('Device Code Flow：使用者拒絕或過期時給出清楚訊息並清除等待中授權', async () => {
  const local = connected();
  delete local.auth;
  const e = env({
    local,
    routes: (url) => (url.endsWith('/device')
      ? { body: { device_code: 'DC', user_code: 'X', verification_uri: 'https://www.twitch.tv/activate', expires_in: 60, interval: 5 } }
      : { status: 400, body: { message: 'authorization_declined' } }),
  });
  await e.core.authStart();
  e.clock.t += 5000;
  await assert.rejects(e.core.authPoll(), /拒絕/);
  assert.equal((await e.core.authPoll()).state, 'none');
  await e.core.authStart();
  e.clock.t += 61_000;
  await assert.rejects(e.core.authPoll(), /過期/);
});

test('網址與頻道解析', () => {
  assert.equal(parseChannel('https://www.twitch.tv/Some_Chan/'), 'some_chan');
  assert.equal(parseChannel('twitch.tv/abc?x=1'), 'abc');
  assert.equal(parseChannel('@abc'), 'abc');
  assert.equal(parseChannel('https://evil.tv/abc'), null);
  assert.equal(parseChannel('https://www.twitch.tv/abc/videos'), null);
  assert.equal(parseTargetUrl(''), '');
  assert.equal(parseTargetUrl('ftp://x.com'), null);
  assert.equal(parseTargetUrl('https://user:pw@x.com'), null);
  assert.equal(safeVerificationUri('http://www.twitch.tv/activate'), null);
  assert.equal(safeVerificationUri('https://twitch.tv.evil.com/activate'), null);

  const channel = tabMatcher({ channel: 'abc', targetUrl: '' });
  assert.ok(channel('https://twitch.tv/ABC/?a=1#b'));
  assert.ok(!channel('https://www.twitch.tv/abcd'));
  assert.ok(!channel('https://www.twitch.tv/abc/clips'));
  const custom = tabMatcher({ channel: 'abc', targetUrl: 'https://Example.com:443/p?q=1' });
  assert.ok(custom('https://example.com/p?q=1#frag'));
  assert.ok(!custom('https://example.com/p?q=2'));
  assert.ok(!custom('https://example.com/p/'));
  assert.ok(!custom('https://example.com/p?q=1&more'));
});

test('多頻道：一次請求查全部，各自觸發、各自記錄場次', async () => {
  const local = connected();
  local.settings.channels = [
    { channel: 'a', targetUrl: '' }, { channel: 'b', targetUrl: 'https://example.com/b' }, { channel: 'c', targetUrl: '' },
  ];
  let data = [{ id: 'A1', user_login: 'A', type: 'live' }, { id: 'B1', user_login: 'b', type: 'live' }];
  const e = env({ local, tabs: [{ id: 9, url: 'https://example.com/b' }], routes: () => ({ body: { data } }) });
  await e.core.tick();
  const q = new URL(e.fetched[0].url).searchParams;
  assert.deepEqual(q.getAll('user_login'), ['a', 'b', 'c']);
  assert.deepEqual(e.calls, [['create', { windowId: 1, url: 'https://www.twitch.tv/a', active: true }], ['reload', 9]]);
  assert.deepEqual(e.local.handledStreams, { a: 'A1', b: 'B1' });
  assert.match(e.local.status.lastCheck, /直播中：a、b/);

  data = [...data, { id: 'C1', user_login: 'c', type: 'live' }];
  await e.core.tick();
  assert.equal(e.calls.length, 3);
  assert.deepEqual(e.local.handledStreams, { a: 'A1', b: 'B1', c: 'C1' });
  assert.equal(e.fetched.length, 2);
});

test('多頻道：某頻道開分頁失敗不影響其他頻道，失敗的下次重試', async () => {
  const local = connected();
  local.settings.channels = [{ channel: 'a', targetUrl: '' }, { channel: 'b', targetUrl: '' }];
  const e = env({ local, routes: () => ({ body: { data: [{ id: 'A1', user_login: 'a', type: 'live' }, { id: 'B1', user_login: 'b', type: 'live' }] } }) });
  let failA = true;
  e.chrome.tabs.create = async (p) => {
    if (failA && p.url.endsWith('/a')) throw new Error('x');
    e.calls.push(['create', p.url]);
  };
  await e.core.tick();
  assert.deepEqual(e.local.handledStreams, { b: 'B1' });
  assert.match(e.local.status.lastError, /^a：/);
  failA = false;
  await e.core.tick();
  assert.deepEqual(e.calls, [['create', 'https://www.twitch.tv/b'], ['create', 'https://www.twitch.tv/a']]);
  assert.equal(e.local.status.lastError, null);
});

test('新增頻道保留既有頻道的場次紀錄；移除的頻道紀錄清掉', async () => {
  const e = env({ local: connected(H('5')), routes: () => offline });
  await e.core.saveSettings({ clientId: CID, channels: 'somechan\nnewone', enabled: true });
  assert.deepEqual(e.local.handledStreams, { somechan: '5' });
  await e.core.saveSettings({ clientId: CID, channels: 'newone', enabled: true });
  assert.deepEqual(e.local.handledStreams, {});
});

test('舊版單頻道設定自動轉換，已處理場次不會重複觸發', async () => {
  const local = connected({ handledStreamId: '7' });
  local.settings = { clientId: CID, channel: 'somechan', targetUrl: 'https://example.com/x', enabled: true };
  const e = env({ local, routes: () => live('7') });
  await e.core.tick();
  assert.equal(e.calls.length, 0);
  const { settings } = await e.core.getState();
  assert.deepEqual(settings.channels, [{ channel: 'somechan', targetUrl: 'https://example.com/x' }]);
});

test('開台時切到前景並守護播放 5 分鐘；既有分頁先切前景再重新整理', async () => {
  const local = connected();
  local.settings.channels = [{ channel: 'a', targetUrl: '' }, { channel: 'b', targetUrl: '' }];
  const tabs = [{ id: 7, windowId: 3, url: 'https://www.twitch.tv/b' }];
  const e = env({ local, tabs, routes: () => ({ body: { data: [
    { id: 'A1', user_login: 'a', type: 'live' }, { id: 'B1', user_login: 'b', type: 'live' }] } }) });
  const order = [];
  const reload = e.chrome.tabs.reload;
  e.chrome.tabs.reload = async (id) => { order.push(`reload:${id}`); return reload(id); };
  const update = e.chrome.tabs.update;
  e.chrome.tabs.update = async (id, p) => { order.push(`front:${id}`); return update(id, p); };
  await e.core.tick();
  assert.deepEqual(e.calls[0], ['create', { windowId: 1, url: 'https://www.twitch.tv/a', active: true }]);
  assert.deepEqual(order, ['front:7', 'reload:7']);
  assert.deepEqual(e.front.filter((f) => f[0] === 'window').map((f) => f[1]), [1, 3]);
  assert.deepEqual(e.played.map((p) => [p.target.tabId, p.args[0], p.func.name]), [[101, 5, 'playbackGuard'], [7, 5, 'playbackGuard']]);
  assert.match(e.local.status.lastAction, /a：已開啟新分頁，影片已開始播放/);
});

test('影片沒開始播放時提示手動播放，但不重複開分頁', async () => {
  const e = env({ local: connected(), routes: () => live('1') });
  e.playResult.value = false;
  await e.core.tick();
  await e.core.tick();
  assert.equal(e.calls.length, 1);
  assert.match(e.local.status.lastAction, /手動按播放/);
});

test('頻道清單解析', () => {
  assert.deepEqual(parseChannelList(' Abc \n\nhttps://twitch.tv/def  https://example.com/p \r\n'), [
    { channel: 'abc', targetUrl: '' }, { channel: 'def', targetUrl: 'https://example.com/p' },
  ]);
  assert.throws(() => parseChannelList(''), /至少/);
  assert.throws(() => parseChannelList('a\nA'), /第 2 行.*重複/);
  assert.throws(() => parseChannelList('a\nbad name!'), /第 2 行格式/);
  assert.throws(() => parseChannelList('a ftp://x.com'), /第 1 行格式/);
  assert.throws(() => parseChannelList('a https://x.com extra'), /第 1 行格式/);
  assert.throws(() => parseChannelList(Array.from({ length: 101 }, (_, i) => `c${i}`).join('\n')), /100/);
});

test('ensureAlarm 只建立一次每分鐘的 alarm', async () => {
  const e = env({ routes: () => offline });
  await ensureAlarm(e.chrome);
  await ensureAlarm(e.chrome);
  assert.deepEqual(e.calls, [['alarm', ALARM, { periodInMinutes: 1, delayInMinutes: 1 }]]);
});
