// 注入 Twitch 頁面執行（chrome.scripting.executeScript），必須自給自足、不引用外部變數。
// 等影片開始播放後回傳 true；之後在頁面內守護指定分鐘數：被暫停就補播、被靜音就解除靜音
// （靜音影片在分頁切到背景時會被瀏覽器暫停，有聲的才會持續播放）。音量維持 Twitch 原本設定。
export async function playbackGuard(minutes) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const video = () => document.querySelector('video');
  const playing = () => { const v = video(); return Boolean(v && !v.paused && v.readyState >= 3); };
  async function kick() {
    document.querySelector('[data-a-target="content-classification-gate-overlay-start-watching-button"],' +
      '[data-a-target="player-overlay-mature-accept"]')?.click();
    const v = video();
    if (!v) return;
    if (v.paused) {
      try {
        await v.play();
      } catch {
        // 有聲自動播放被擋時，先靜音播放（一定允許），下面再解除靜音。
        v.muted = true;
        try { await v.play(); } catch {}
      }
    }
    if (!v.paused && v.muted) v.muted = false;
  }

  const until = Date.now() + minutes * 60_000;
  if (window.__twitchLiveGuard) {
    window.__twitchLiveGuard.until = Math.max(window.__twitchLiveGuard.until, until);
  } else {
    const state = (window.__twitchLiveGuard = { until });
    (async () => {
      while (Date.now() < state.until) {
        await sleep(5000);
        const v = video();
        if (!playing() || v?.muted) await kick();
      }
      window.__twitchLiveGuard = null;
    })();
  }

  const start = Date.now();
  while (Date.now() - start < 20_000) {
    if (playing()) {
      if (video().muted) await kick();
      return true;
    }
    if (Date.now() - start > 4000) await kick(); // 先給 Twitch 自己自動播放的時間
    await sleep(500);
  }
  return false;
}
