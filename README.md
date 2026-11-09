# Twitch 開台自動開啟（Chromium 系瀏覽器擴充功能：Brave、Chrome、Edge 等）

監看多個 Twitch 頻道（最多 100 個）。任一頻道開台時開啟它對應的網址並切到該分頁；如果已經有相同網址的分頁，就切過去並重新整理，不另開。Twitch 頁面會自動保持影片播放 5 分鐘。

- 約每分鐘用 Twitch 官方 API 檢查一次（目標值，不保證準時）；不論幾個頻道，每次都只發一個請求。
- 需要瀏覽器保持執行；電腦睡眠或關閉瀏覽器時會暫停檢查，恢復後繼續。
- 每個頻道各自記錄：同一場直播只觸發一次（重啟瀏覽器後仍記得）；新的一場就算沒偵測到中間的離線，也會觸發。
- 剛啟用監控、剛安裝或新加入頻道時，如果該頻道正在直播，會觸發一次。
- 某個頻道開分頁失敗不影響其他頻道，失敗的那個下次檢查會重試。
- 從舊版（單頻道）升級時，原本的設定與已處理場次會自動沿用。
- 授權資料只存在這台電腦該瀏覽器的擴充功能儲存空間，不會傳到 Twitch 以外的地方。

## 下載

到本儲存庫的 **Releases** 下載最新的 `twitch-live-opener-x.y.z.zip`，解壓後依壓縮檔內的 `使用說明.txt` 安裝。已實測 Chrome、Edge、Brave；不支援 Firefox、Safari。

## 1. 在 Twitch 註冊應用程式（只需一次）

1. 開啟 [Twitch 開發者主控台](https://dev.twitch.tv/console/apps) 並登入。帳號必須先啟用兩步驟驗證 (2FA)。
2. 進入 Applications，按「Register Your Application」。
3. 填寫：
   - **Name**：自訂（需全站唯一）。
   - **OAuth Redirect URLs**：填 `http://localhost`。本工具使用 Device Code Flow，不會用到這個網址，只是主控台要求必填。
   - **Category**：Application Integration（或 Other）。
   - **Client Type**：選 **Public**（公開）。
4. 建立後複製 **Client ID**。本工具不需要、也不要輸入 Client Secret。

## 2. 載入擴充功能

1. 網址列輸入擴充功能頁：Brave `brave://extensions`、Chrome `chrome://extensions`、Edge `edge://extensions`。
2. 開啟右上角「開發人員模式」。
3. 按「載入未封裝項目」(Load unpacked)，選擇本資料夾（含 `manifest.json` 的那層）。
4. 建議把擴充功能釘選到工具列。

## 3. 設定與連接

1. 按工具列上的擴充功能圖示，會開啟設定頁。
2. 填入 Client ID；頻道每行一個（可貼上 `https://www.twitch.tv/頻道`），要開其他網址就在頻道後空一格接網址，例如 `shroud https://example.com/page`。勾選「啟用監控」，按「儲存設定」。
3. 按「連接 Twitch」，在開啟的 Twitch 頁面確認代碼並同意授權。**完成前請保持設定頁開啟**，設定頁會自動確認結果。
4. 可選一個頻道按「測試開啟／重新整理」確認分頁行為（不需授權、不影響開台判斷），或按「立即檢查」。

## 影片播放

Chromium 系瀏覽器不會播放「在背景開啟、從未顯示過」的分頁裡的影片，靜音的影片在分頁切到背景時也會被暫停。因此開台時：

- 直播分頁會切到前景，瀏覽器視窗也會被帶到最前面，並停留在該分頁。多個頻道同時開台時依序處理，等前一個開始播放才切到下一個，最後停在最後一個。
- 影片開始播放後，若被靜音會自動解除靜音（音量維持 Twitch 播放器原本的設定）；之後你切到別的分頁，影片仍會在背景繼續播。
- 5 分鐘內每 5 秒檢查一次：影片被暫停就自動恢復播放，遇到成人內容提示會自動按「開始觀看」。之後就不再干預，你可以自己暫停。
- 只對 Twitch 網址守護播放；自訂成其他網站的網址只會開啟或重新整理分頁。
- 「上次動作」會顯示影片是否已開始播放；若沒有，請手動按播放。

## 分頁比對規則

- 只看一般視窗的分頁，不碰無痕視窗與其他分頁；每個頻道每次開台最多重新整理一個分頁。
- 目標網址留空（預設頻道頁）：`www.twitch.tv` 與 `twitch.tv`、頻道名稱大小寫、結尾斜線都視為相同；頻道首頁的 `?query` 和 `#hash` 會忽略。`/頻道/videos` 這類子頁不算。
- 自訂網址：必須是同一個網址，只忽略 `#` 之後的片段；`?query` 不同就算不同網址。

## 授權與權限

- 使用 OAuth Device Code Flow（公開用戶端），不要求任何額外 scope。
- token 會在過期或被拒時自動更新；啟動時與每小時（包含監控關閉時）驗證一次。授權失效、被撤銷或 Client ID 不符時，設定頁會要求重新連接。更換 Client ID 會清除舊授權。
- 「中斷本機授權」只刪除本機儲存的授權。若要讓 Twitch 端也撤銷，請到 Twitch「設定 → 連結」中中斷此應用程式的連結。
- 權限只有 `storage`、`alarms`、`tabs`、`scripting`。網路存取只限 `https://api.twitch.tv/*` 與 `https://id.twitch.tv/*`；`www.twitch.tv` 與 `twitch.tv` 的權限只用來在開台分頁裡執行播放守護。

## 已知限制

- 頻道不存在時會顯示為「未直播」。
- Twitch 回傳 429 時，會依 `Retry-After`／`Ratelimit-Reset` 完整暫停到冷卻結束（兩者都沒有時預設 60 秒），期間包含連接授權在內的所有 Twitch 請求都不會送出。授權碼若在冷卻期間過期，需重新按「連接 Twitch」。

## 開發者：執行測試

需要 Node.js 20 以上，無需安裝套件：

```
node --test tests/*.test.mjs
```

## 參考文件

- [Device Code Grant Flow](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#device-code-grant-flow)
- [Registering Your App](https://dev.twitch.tv/docs/authentication/register-app/)
- [Validating Tokens](https://dev.twitch.tv/docs/authentication/validate-tokens/)
- [Get Streams](https://dev.twitch.tv/docs/api/reference/#get-streams)
- [chrome.alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms)
