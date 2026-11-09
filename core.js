// Twitch 開台自動開啟分頁：核心邏輯（背景 service worker 與測試共用，不含 DOM）。
import { playbackGuard } from './playback.js';

export const ALARM = 'twitch-live-check';
const PLAY_GUARD_MINUTES = 5;
const ID_BASE = 'https://id.twitch.tv/oauth2';
const HELIX_BASE = 'https://api.twitch.tv/helix';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const TIMEOUT_MS = 10_000;
const VALIDATE_EVERY_MS = 60 * 60 * 1000;
const REFRESH_SKEW_MS = 60_000;
// Get Streams 一次最多查 100 個 user_login，所以頻道上限 100，每次檢查只發一個請求。
const MAX_CHANNELS = 100;
const DEFAULT_SETTINGS = { clientId: '', channels: [], enabled: false };

const MESSAGES = {
  network: '無法連線到 Twitch，下次檢查會重試。',
  timeout: 'Twitch 回應逾時，下次檢查會重試。',
  server: 'Twitch 暫時發生錯誤，下次檢查會重試。',
  rate: 'Twitch 要求暫緩請求，冷卻結束後會自動重試。',
  malformed: 'Twitch 回應格式異常，已保留狀態，下次檢查會重試。',
  request: 'Twitch 拒絕了請求，請確認 Client ID 與頻道名稱。',
  reconnect: 'Twitch 授權已失效或被撤銷，請重新連接 Twitch。',
  mismatch: '授權所屬的 Client ID 與設定不符，請重新連接 Twitch。',
};

export class UserError extends Error {}
class TwitchError extends Error {
  constructor(kind, until) {
    super(MESSAGES[kind]);
    this.kind = kind;
    this.until = until;
  }
}

// 只回傳我們自己寫的訊息，不外露伺服器內容或例外細節。
export function publicError(e) {
  return e instanceof UserError || e instanceof TwitchError ? e.message : '發生未預期的錯誤，請稍後再試。';
}

const isHttp = (u) => u.protocol === 'https:' || u.protocol === 'http:';
const isTwitchHost = (host) => host === 'www.twitch.tv' || host === 'twitch.tv';

export const channelUrl = (login) => `https://www.twitch.tv/${login}`;

// 接受 "name"、"@name"、"twitch.tv/name"、"https://www.twitch.tv/name/?x"。
export function parseChannel(input) {
  let s = String(input ?? '').trim().replace(/^@/, '');
  if (/[/.:]/.test(s)) {
    let u;
    try {
      u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    } catch {
      return null;
    }
    const parts = u.pathname.split('/').filter(Boolean);
    if (!isHttp(u) || !isTwitchHost(u.hostname) || parts.length !== 1) return null;
    s = parts[0];
  }
  s = s.toLowerCase();
  return /^[a-z0-9_]{1,25}$/.test(s) ? s : null;
}

// 空字串代表使用預設頻道網址；不合法回傳 null。
export function parseTargetUrl(input) {
  const s = String(input ?? '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    return isHttp(u) && u.hostname && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

// 每行一個頻道，可在後面空一格加目標網址；空行略過。回傳 [{ channel, targetUrl }]。
export function parseChannelList(text) {
  const out = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].trim().split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    const n = `第 ${i + 1} 行`;
    if (parts.length > 2 || (parts[1] && !/^https?:\/\//i.test(parts[1]))) {
      throw new UserError(`${n}格式不正確：頻道名稱不能有空格；要指定網址時，請在頻道後空一格接 http:// 或 https:// 開頭的網址。`);
    }
    const channel = parseChannel(parts[0]);
    if (!channel) throw new UserError(`${n}的頻道名稱不正確，請輸入頻道帳號或 https://www.twitch.tv/頻道 網址。`);
    const targetUrl = parseTargetUrl(parts[1]);
    if (targetUrl === null) throw new UserError(`${n}的目標網址必須是 http:// 或 https:// 開頭的完整網址。`);
    if (out.some((c) => c.channel === channel)) throw new UserError(`${n}的頻道 ${channel} 重複了。`);
    out.push({ channel, targetUrl });
  }
  if (!out.length) throw new UserError('請至少輸入一個頻道。');
  if (out.length > MAX_CHANNELS) throw new UserError(`最多只能監看 ${MAX_CHANNELS} 個頻道。`);
  return out;
}

export function safeVerificationUri(value) {
  try {
    const u = new URL(value);
    if (u.protocol === 'https:' && isTwitchHost(u.hostname) && !u.port && !u.username && !u.password &&
        /^\/activate\/?$/.test(u.pathname)) return u.href;
  } catch {}
  return null;
}

function canonicalUrl(value) {
  try {
    const u = new URL(value);
    if (!isHttp(u)) return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

// 預設頻道網址：www/無 www、大小寫、結尾斜線皆視為相同，且只在頻道根目錄忽略 query/hash。
// 自訂網址：標準化後完全相同，只忽略 fragment。
export function tabMatcher(settings) {
  if (!settings.targetUrl) {
    const path = `/${settings.channel}`;
    return (value) => {
      try {
        const u = new URL(value);
        return isHttp(u) && isTwitchHost(u.hostname) && !u.port &&
          u.pathname.replace(/\/$/, '').toLowerCase() === path;
      } catch {
        return false;
      }
    };
  }
  const want = canonicalUrl(settings.targetUrl);
  return (value) => want !== null && canonicalUrl(value) === want;
}

// 回傳 { 頻道: 直播場次 id }，只含正在直播的頻道。
export function parseStreams(body, logins) {
  if (!body || !Array.isArray(body.data)) throw new TwitchError('malformed');
  const live = {};
  for (const s of body.data) {
    if (typeof s?.user_login !== 'string' || typeof s.id !== 'string' || !s.id) throw new TwitchError('malformed');
    const login = s.user_login.toLowerCase();
    if (logins.includes(login) && s.type === 'live') live[login] = s.id;
  }
  return live;
}

export async function ensureAlarm(chrome) {
  if (!(await chrome.alarms.get(ALARM))) {
    await chrome.alarms.create(ALARM, { periodInMinutes: 1, delayInMinutes: 1 });
  }
}

export function createCore({
  chrome, fetch: fetchFn = (...a) => globalThis.fetch(...a), now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const local = chrome.storage.local;
  const session = chrome.storage.session;
  let queue = Promise.resolve();
  // 所有會改狀態的操作排隊執行，避免重複開分頁或與設定變更交錯。
  const serial = (fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };
  // 設定或授權變更時立即遞增（不等排隊），讓進行中的檢查放棄過期的動作。
  let version = 0;
  let refreshing = null;

  async function load() {
    const r = await local.get(['settings', 'auth', 'authProblem', 'status', 'handledStreams', 'handledStreamId']);
    const { channel, targetUrl, ...rest } = r.settings ?? {};
    const settings = { ...DEFAULT_SETTINGS, ...rest };
    // 舊版單頻道設定自動轉成清單。
    if (!Array.isArray(rest.channels)) settings.channels = channel ? [{ channel, targetUrl: targetUrl || '' }] : [];
    let handled = r.handledStreams;
    if (!handled) handled = channel && r.handledStreamId ? { [channel]: r.handledStreamId } : {};
    return {
      settings,
      auth: r.auth ?? null,
      authProblem: r.authProblem ?? null,
      status: { ...r.status },
      handled,
    };
  }

  async function patchStatus(patch) {
    const { status } = await local.get('status');
    await local.set({ status: { ...status, ...patch } });
  }

  async function dropAuth(problem) {
    await local.set({ auth: null, authProblem: problem });
    throw new TwitchError(problem);
  }

  async function cooldownUntil() {
    const { status } = await local.get('status');
    return status?.cooldownUntil ?? 0;
  }

  // Twitch 指定的冷卻時間完整遵守；兩個標頭都沒有有效的未來時間才用預設 60 秒。
  function cooldownFrom(headers) {
    const t = now();
    const retryAfter = headers?.get?.('Retry-After')?.trim() ?? '';
    const reset = Number(headers?.get?.('Ratelimit-Reset'));
    const candidates = [
      /^\d+$/.test(retryAfter) ? t + Number(retryAfter) * 1000 : Date.parse(retryAfter),
      reset > 0 ? reset * 1000 : NaN,
    ].filter((x) => x > t);
    return candidates.length ? Math.max(...candidates) : t + 60_000;
  }

  // 所有 Twitch 請求（含授權）都經過這裡：冷卻中不送出，收到 429 立即記錄冷卻。
  async function http(url, init = {}) {
    const blocked = await cooldownUntil();
    if (blocked > now()) throw new TwitchError('rate', blocked);
    let res;
    try {
      res = await fetchFn(url, { ...init, cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw new TwitchError(e?.name === 'TimeoutError' ? 'timeout' : 'network');
    }
    let body = null;
    try {
      body = await res.json();
    } catch {}
    let until;
    if (res.status === 429) {
      until = Math.max(cooldownFrom(res.headers), await cooldownUntil());
      await patchStatus({ cooldownUntil: until });
    }
    return { status: res.status, headers: res.headers, body, until };
  }

  function failure(r) {
    if (r.status === 429) return new TwitchError('rate', r.until);
    return new TwitchError(r.status >= 500 ? 'server' : 'request');
  }

  function tokenFrom(body, clientId, previous) {
    const refreshToken = body?.refresh_token || previous?.refreshToken;
    if (typeof body?.access_token !== 'string' || !body.access_token || typeof refreshToken !== 'string') {
      throw new TwitchError('malformed');
    }
    const expiresIn = Number(body.expires_in);
    return {
      ...previous,
      clientId,
      accessToken: body.access_token,
      refreshToken,
      expiresAt: now() + (expiresIn > 0 ? expiresIn : 3600) * 1000,
    };
  }

  // 公開用戶端的 refresh token 每次使用後會輪替，所以同時只允許一個更新請求。
  function refresh(auth) {
    refreshing ??= (async () => {
      try {
        const r = await http(`${ID_BASE}/token`, {
          method: 'POST',
          body: new URLSearchParams({
            client_id: auth.clientId, grant_type: 'refresh_token', refresh_token: auth.refreshToken,
          }),
        });
        if (r.status === 400 || r.status === 401 || r.status === 403) await dropAuth('reconnect');
        if (r.status !== 200) throw failure(r);
        const next = tokenFrom(r.body, auth.clientId, auth);
        await local.set({ auth: next });
        return next;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  // 401 時最多更新一次 token 後重試；仍失敗就要求重新連接。
  async function authed(url, auth, headers) {
    if (auth.expiresAt - REFRESH_SKEW_MS <= now()) auth = await refresh(auth);
    let r = await http(url, { headers: headers(auth) });
    if (r.status === 401) {
      auth = await refresh(auth);
      r = await http(url, { headers: headers(auth) });
      if (r.status === 401) await dropAuth('reconnect');
    }
    if (r.status !== 200) throw failure(r);
    return { body: r.body, auth };
  }

  async function validate(auth, settings) {
    const res = await authed(`${ID_BASE}/validate`, auth, (a) => ({ Authorization: `OAuth ${a.accessToken}` }));
    const body = res.body;
    if (typeof body?.client_id !== 'string') throw new TwitchError('malformed');
    if (body.client_id !== settings.clientId || res.auth.clientId !== settings.clientId) await dropAuth('mismatch');
    const next = { ...res.auth, validatedAt: now(), login: typeof body.login === 'string' ? body.login : null };
    if (Number(body.expires_in) > 0) next.expiresAt = now() + Number(body.expires_in) * 1000;
    await local.set({ auth: next });
    return next;
  }

  async function maintainAuth({ settings, auth }, force) {
    if (!auth) return null;
    if (auth.clientId !== settings.clientId) await dropAuth('mismatch');
    if (force || now() - (auth.validatedAt ?? 0) >= VALIDATE_EVERY_MS) return validate(auth, settings);
    return auth;
  }

  // 切到前景並把視窗帶到最前面：Chromium 系瀏覽器不會播放從未顯示過的分頁裡的影片。
  async function bringToFront(tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  }

  async function createTab(url) {
    const windows = (await chrome.windows.getAll({ windowTypes: ['normal'] })).filter((w) => !w.incognito);
    const win = windows.find((w) => w.focused) ?? windows[0];
    if (win) {
      const tab = await chrome.tabs.create({ windowId: win.id, url, active: true });
      await chrome.windows.update(win.id, { focused: true });
      return tab;
    }
    const w = await chrome.windows.create({ url, focused: true });
    return w?.tabs?.[0];
  }

  // entry = { channel, targetUrl }；回傳 { action, tabId, url }
  async function openOrReload(entry) {
    const matches = tabMatcher(entry);
    const url = entry.targetUrl || channelUrl(entry.channel);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const tabs = (await chrome.tabs.query({ windowType: 'normal' }))
          .filter((t) => !t.incognito && t.id != null);
        // 正在導向其他網址的分頁不算；正在載入目標的分頁已是最新，不再重新整理。
        const loading = tabs.find((t) => t.pendingUrl && matches(t.pendingUrl));
        if (loading) {
          await bringToFront(loading);
          return { action: '目標分頁正在載入，已切到該分頁', tabId: loading.id, url };
        }
        const hit = tabs
          .filter((t) => !t.pendingUrl && t.url && matches(t.url))
          .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
        if (!hit) break;
        try {
          // 先切到前景再重新整理，讓 Twitch 播放器在可見狀態下載入（背景載入不會自動播放）。
          await bringToFront(hit);
          await chrome.tabs.reload(hit.id);
          return { action: '已重新整理既有分頁並切到該分頁', tabId: hit.id, url };
        } catch {
          // 分頁可能剛被關閉，重新查詢一次。
        }
      }
      const tab = await createTab(url);
      return { action: '已開啟新分頁', tabId: tab?.id, url };
    } catch {
      throw new UserError('無法開啟或重新整理分頁，下次檢查會重試。');
    }
  }

  async function waitForLoad(tabId) {
    for (let i = 0; i < 60; i++) {
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'complete' && !t.pendingUrl) return;
      await sleep(500);
    }
  }

  // 只在 Twitch 頁面守護播放；回傳附加在動作後的說明。開分頁已成功，所以這裡的失敗不重試。
  async function ensurePlayback({ tabId, url }) {
    if (tabId == null || !isTwitchHost(new URL(url).hostname)) return '';
    try {
      await waitForLoad(tabId);
      const [res] = await chrome.scripting.executeScript({
        target: { tabId }, func: playbackGuard, args: [PLAY_GUARD_MINUTES],
      });
      return res?.result
        ? `，影片已開始播放（${PLAY_GUARD_MINUTES} 分鐘內會自動保持播放）`
        : '，但影片沒有自動開始播放，請手動按播放';
    } catch {
      return '，但無法確認影片播放狀態';
    }
  }

  async function openAndPlay(entry) {
    const opened = await openOrReload(entry);
    return opened.action + (await ensurePlayback(opened));
  }

  function tick({ manual = false, forceValidate = false } = {}) {
    return serial(async () => {
      const v = version;
      const state = await load();
      const { settings, status, handled } = state;
      const at = now();
      const record = (patch) => patchStatus({ lastCheckAt: at, ...patch });
      if (manual && !settings.enabled) throw new UserError('監控目前關閉，請先勾選「啟用監控」並儲存。');
      if (status.cooldownUntil > at) {
        if (manual) throw new UserError(MESSAGES.rate);
        return;
      }
      try {
        const auth = await maintainAuth(state, forceValidate);
        if (!settings.enabled) return;
        if (!settings.clientId || !settings.channels.length) return record({ lastCheck: '尚未完成設定', lastError: null });
        if (!auth) return record({ lastCheck: '尚未連接 Twitch，未檢查', lastError: null });
        const logins = settings.channels.map((c) => c.channel);
        const query = new URLSearchParams([...logins.map((l) => ['user_login', l]), ['first', String(MAX_CHANNELS)]]);
        const res = await authed(
          `${HELIX_BASE}/streams?${query}`, auth,
          (a) => ({ 'Client-Id': a.clientId, Authorization: `Bearer ${a.accessToken}` }),
        );
        const live = parseStreams(res.body, logins);
        const actions = [];
        const errors = [];
        for (const entry of settings.channels) {
          const id = live[entry.channel];
          if (!id || id === handled[entry.channel]) continue;
          if (version !== v) return; // 檢查期間設定已變更，交給下一次檢查。
          try {
            actions.push(`${entry.channel}：${await openAndPlay(entry)}`);
            handled[entry.channel] = id;
            await local.set({ handledStreams: handled }); // 每個頻道成功就存，避免後面失敗時重複觸發。
          } catch (e) {
            errors.push(`${entry.channel}：${publicError(e)}`);
          }
        }
        const liveNames = logins.filter((l) => live[l]);
        const summary = liveNames.length
          ? `直播中：${liveNames.join('、')}（共 ${logins.length} 個頻道）`
          : `都未直播（共 ${logins.length} 個頻道）`;
        await record({
          lastCheck: summary,
          lastError: errors.length ? errors.join('\n') : null,
          ...(actions.length && { lastAction: actions.join('\n'), lastActionAt: now() }),
        });
      } catch (e) {
        const patch = { lastError: publicError(e) };
        await (settings.enabled ? record({ ...patch, lastCheck: '檢查失敗（已保留處理狀態）' }) : patchStatus(patch));
      }
    });
  }

  async function saveSettings(input = {}) {
    version++;
    const clientId = String(input.clientId ?? '').trim();
    if (!/^[A-Za-z0-9]{10,64}$/.test(clientId)) throw new UserError('Client ID 格式不正確（應為英數字）。');
    const channels = parseChannelList(input.channels);
    const enabled = Boolean(input.enabled);
    return serial(async () => {
      const { settings: prev, handled } = await load();
      // 新啟用時全部清除；否則只保留仍在清單中的頻道。新加入的頻道若正在直播會觸發一次。
      const kept = {};
      if (!enabled || prev.enabled) {
        for (const c of channels) if (handled[c.channel]) kept[c.channel] = handled[c.channel];
      }
      const updates = { settings: { clientId, channels, enabled }, handledStreams: kept };
      await local.remove('handledStreamId');
      if (clientId !== prev.clientId) {
        updates.auth = null;
        updates.authProblem = null;
        await session.remove('pending');
      }
      await local.set(updates);
    });
  }

  function testOpen(channel) {
    return serial(async () => {
      const { settings } = await load();
      const entry = settings.channels.find((c) => c.channel === channel) ?? settings.channels[0];
      if (!entry) throw new UserError('請先儲存頻道設定。');
      const action = await openAndPlay(entry);
      await patchStatus({ lastAction: `測試 ${entry.channel}：${action}`, lastActionAt: now() });
      return action;
    });
  }

  const publicPending = (p) => ({ userCode: p.userCode, verificationUri: p.uri, expiresAt: p.expiresAt });
  const expiredMessage = '授權碼已過期，請重新按「連接 Twitch」。';

  function authStart() {
    return serial(async () => {
      const { settings } = await load();
      if (!settings.clientId) throw new UserError('請先填寫並儲存 Client ID。');
      const r = await http(`${ID_BASE}/device`, {
        method: 'POST', body: new URLSearchParams({ client_id: settings.clientId, scopes: '' }),
      });
      if (r.status === 429 || r.status >= 500) throw failure(r);
      if (r.status !== 200) {
        throw new UserError('Twitch 拒絕授權請求，請確認 Client ID 正確，且應用程式的用戶端類型為「公開」(Public)。');
      }
      const b = r.body ?? {};
      const uri = safeVerificationUri(b.verification_uri);
      if (!uri || typeof b.device_code !== 'string' || !b.device_code || typeof b.user_code !== 'string' || !b.user_code) {
        throw new TwitchError('malformed');
      }
      const interval = Number(b.interval) > 0 ? Number(b.interval) : 5;
      const expiresIn = Number(b.expires_in) > 0 ? Number(b.expires_in) : 1800;
      const pending = {
        clientId: settings.clientId, deviceCode: b.device_code, userCode: b.user_code, uri,
        interval, expiresAt: now() + expiresIn * 1000, nextPollAt: now() + interval * 1000,
      };
      await session.set({ pending });
      return publicPending(pending);
    });
  }

  function authPoll() {
    return serial(async () => {
      const { pending } = await session.get('pending');
      if (!pending) return { state: 'none' };
      const state = await load();
      if (pending.clientId !== state.settings.clientId) {
        await session.remove('pending');
        return { state: 'none' };
      }
      if (now() >= pending.expiresAt) {
        await session.remove('pending');
        throw new UserError(expiredMessage);
      }
      // 冷卻中只回報等待，不送請求也不丟錯，避免設定頁反覆重試。
      if (now() < pending.nextPollAt || (await cooldownUntil()) > now()) {
        return { state: 'pending', ...publicPending(pending) };
      }
      pending.nextPollAt = now() + pending.interval * 1000;
      await session.set({ pending });
      const r = await http(`${ID_BASE}/token`, {
        method: 'POST',
        body: new URLSearchParams({
          client_id: pending.clientId, scopes: '', device_code: pending.deviceCode, grant_type: DEVICE_GRANT,
        }),
      });
      if (r.status === 200) {
        const auth = tokenFrom(r.body, pending.clientId, null);
        await session.remove('pending');
        version++;
        await local.set({ auth, authProblem: null });
        try {
          await validate(auth, state.settings);
        } catch (e) {
          if (e?.kind === 'mismatch' || e?.kind === 'reconnect') throw e;
        }
        return { state: 'connected' };
      }
      // 只用伺服器訊息判斷狀態，不顯示原文。
      const code = String(r.body?.message ?? r.body?.error ?? '').toLowerCase();
      if (r.status === 429 || code.includes('authorization_pending')) return { state: 'pending', ...publicPending(pending) };
      if (code.includes('slow_down')) {
        pending.interval += 5;
        pending.nextPollAt = now() + pending.interval * 1000;
        await session.set({ pending });
        return { state: 'pending', ...publicPending(pending) };
      }
      if (r.status >= 500) throw failure(r);
      await session.remove('pending');
      if (code.includes('denied') || code.includes('declined')) {
        throw new UserError('授權已被拒絕。若要使用，請重新按「連接 Twitch」。');
      }
      if (code.includes('expired') || code.includes('invalid device code')) throw new UserError(expiredMessage);
      throw new UserError('Twitch 授權失敗，請重新按「連接 Twitch」。');
    });
  }

  function disconnect() {
    version++;
    return serial(async () => {
      await session.remove('pending');
      await local.set({ auth: null, authProblem: null });
    });
  }

  // 只回傳可顯示的資訊，絕不包含 token 或 device code。
  async function getState() {
    const { settings, auth, authProblem, status, handled } = await load();
    const { pending } = await session.get('pending');
    return {
      settings,
      connection: auth ? 'connected' : authProblem ? 'reconnect' : 'disconnected',
      login: auth?.login ?? null,
      authMessage: authProblem ? MESSAGES[authProblem] : null,
      pending: pending && now() < pending.expiresAt ? publicPending(pending) : null,
      status,
      handledStreams: handled,
    };
  }

  return { tick, saveSettings, testOpen, authStart, authPoll, disconnect, getState };
}
