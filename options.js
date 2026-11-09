'use strict';

const $ = (id) => document.getElementById(id);
const form = $('settings-form');
const buttons = [...document.querySelectorAll('button')];
let polling = false;

async function send(type, extra = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...extra });
  if (!res?.ok) throw new Error(res?.error || '發生未預期的錯誤，請稍後再試。');
  return res.result;
}

function say(text, isError = false) {
  const el = $('feedback');
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.setAttribute('role', isError ? 'alert' : 'status');
}

const time = (ts) => (ts ? new Date(ts).toLocaleString('zh-TW') : '尚無');

function fillForm(settings) {
  $('clientId').value = settings.clientId;
  $('channels').value = settings.channels.map((c) => (c.targetUrl ? `${c.channel} ${c.targetUrl}` : c.channel)).join('\n');
  $('enabled').checked = settings.enabled;
}

function renderTestChannels(channels) {
  const select = $('test-channel');
  const keep = select.value;
  select.replaceChildren(...channels.map((c) => new Option(c.channel, c.channel)));
  if (channels.some((c) => c.channel === keep)) select.value = keep;
}

function render(state) {
  const { settings, status, pending } = state;
  renderTestChannels(settings.channels);
  $('connection').textContent =
    state.connection === 'connected' ? `已連接${state.login ? `（${state.login}）` : ''}`
      : state.connection === 'reconnect' ? `需要重新連接：${state.authMessage}`
        : pending ? '等待你在 Twitch 確認授權…' : '未連接';
  $('pending').hidden = !pending;
  if (pending) {
    $('verify-link').href = pending.verificationUri;
    $('user-code').textContent = pending.userCode;
    if (!polling) pollAuth();
  }
  const cooldown = status.cooldownUntil > Date.now() ? `（Twitch 要求暫緩，${time(status.cooldownUntil)} 後恢復）` : '';
  $('monitor').textContent = (settings.enabled ? `啟用中：${settings.channels.map((c) => c.channel).join('、')}` : '已關閉') + cooldown;
  $('last-check').textContent = status.lastCheckAt ? `${time(status.lastCheckAt)}：${status.lastCheck}` : '尚無';
  $('last-action').textContent = status.lastActionAt ? `${time(status.lastActionAt)}：${status.lastAction}` : '尚無';
  $('last-error').textContent = status.lastError || '無';
}

async function refresh() {
  const state = await send('getState');
  // 只換了頁面、背景還是舊版時會沒有 channels。
  if (!Array.isArray(state?.settings?.channels)) {
    throw new Error('擴充功能背景還是舊版：請到 brave://extensions 在本擴充功能上按「重新載入」(↻)，再重新開啟本頁。');
  }
  render(state);
  return state;
}

async function run(button, work) {
  buttons.forEach((b) => { b.disabled = true; });
  try {
    await work();
  } catch (e) {
    say(e.message, true);
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
    button?.focus();
    refresh().catch(() => {});
  }
}

// 背景每次最多依 Twitch 指定的間隔真正送出請求，這裡只是定時詢問結果。
async function pollAuth() {
  polling = true;
  try {
    for (;;) {
      const r = await send('authPoll');
      if (r.state === 'connected') return say('已成功連接 Twitch。');
      if (r.state === 'none') return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (e) {
    say(e.message, true);
  } finally {
    polling = false;
    refresh().catch(() => {});
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  run(form.querySelector('button'), async () => {
    await send('save', { settings: {
      clientId: $('clientId').value, channels: $('channels').value, enabled: $('enabled').checked,
    } });
    fillForm((await refresh()).settings);
    say('設定已儲存。');
  });
});

$('connect').addEventListener('click', (event) => run(event.target, async () => {
  await send('authStart');
  say('請在新開的 Twitch 頁面確認授權，完成前保持本分頁開啟。');
  const state = await refresh();
  if (state.pending) window.open(state.pending.verificationUri, '_blank', 'noopener');
}));

$('disconnect').addEventListener('click', (event) => run(event.target, async () => {
  await send('disconnect');
  say('已清除本機的 Twitch 授權。');
}));

$('check-now').addEventListener('click', (event) => run(event.target, async () => {
  await send('checkNow');
  const { status } = await refresh();
  say(status.lastError ? `檢查完成，但有錯誤：${status.lastError}` : `檢查完成：${status.lastCheck ?? '—'}`, Boolean(status.lastError));
}));

$('test-open').addEventListener('click', (event) => run(event.target, async () => {
  say(`測試完成：${await send('testOpen', { channel: $('test-channel').value })}`);
}));

chrome.storage.onChanged.addListener(() => refresh().catch(() => {}));

refresh().then((state) => fillForm(state.settings), (e) => say(e.message, true));
