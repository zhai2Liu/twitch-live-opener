import { ALARM, createCore, ensureAlarm, publicError } from './core.js';

const core = createCore({ chrome });
const ignore = () => {};

// 憑證與狀態只給擴充功能自己的頁面讀取（預設 local 也開放給 content script）。
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(ignore);
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(ignore);
ensureAlarm(chrome).catch(ignore);

const onBrowserStart = () => {
  ensureAlarm(chrome).catch(ignore);
  core.tick({ forceValidate: true }).catch(ignore);
};
chrome.runtime.onInstalled.addListener(onBrowserStart);
chrome.runtime.onStartup.addListener(onBrowserStart);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) core.tick().catch(ignore);
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

const handlers = {
  getState: () => core.getState(),
  save: (msg) => core.saveSettings(msg.settings),
  checkNow: () => core.tick({ manual: true }),
  testOpen: (msg) => core.testOpen(String(msg.channel ?? '')),
  authStart: () => core.authStart(),
  authPoll: () => core.authPoll(),
  disconnect: () => core.disconnect(),
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const handler = Object.hasOwn(handlers, msg?.type) && handlers[msg.type];
  if (!handler || sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  Promise.resolve()
    .then(() => handler(msg))
    .then((result) => reply({ ok: true, result }), (e) => reply({ ok: false, error: publicError(e) }));
  return true;
});
