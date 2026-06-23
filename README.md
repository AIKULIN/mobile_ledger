## 這是一個簡易的手機記帳
1. 預設資料會儲存在目前瀏覽器（localStorage）。
2. 不建議在 Line 內建瀏覽器開啟，資料可能遺失。
3. 由於資料存在瀏覽器本機，用哪個瀏覽器建立資料，就要用同一個瀏覽器讀取。
4. 無痕模式不適用，資料不會保存。
5. 若清除瀏覽器資料，未備份的資料會遺失。
6. 本機資料是「Base64 編碼儲存（混淆）」，不是密碼學加密。

## 目前架構
1. 已改為 `Cloudflare Workers + Static Assets + D1` 架構。
2. 記帳資料本體仍只存在：
   - 使用者目前瀏覽器的 `localStorage`
   - 使用者自己的 Google Drive `Mobile Ledger Backup` 資料夾
3. Worker 後端不保存記帳內容，只負責：
   - Google OAuth 登入流程
   - session cookie 驗證
   - Google Drive 備份與還原 API 代理
   - refresh token 保管與 access token 更新
4. D1 目前儲存的是最小授權資料：
   - `users`：Google 帳號識別、email、refresh token、access token、Drive folder id
   - `sessions`：登入 session
   - `oauth_states`：OAuth PKCE 流程暫存資料
5. 目前已提供：
   - `GET /api/health`
   - `GET /api/session`
   - `GET /auth/google/start`
   - `GET /auth/google/callback`
   - `POST /auth/logout`
   - `GET /api/backups`
   - `POST /api/backups`
   - `GET /api/backups/:id`
6. Google OAuth 已接上 `Authorization Code Flow + PKCE`。

## Cloudflare 設定
1. 安裝依賴：`npm install`
2. 建立本機 secret：將 `.dev.vars.example` 複製為 `.dev.vars`
3. 在 `.dev.vars` 設定：
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `SESSION_SECRET`
4. 設定 [wrangler.jsonc](/Users/user/tmp/project/mobile_ledger/wrangler.jsonc) 內的：
   - `env.staging.vars.APP_BASE_URL`
   - `env.production.vars.APP_BASE_URL`
   - `env.staging.d1_databases[0].database_id`
   - `env.production.d1_databases[0].database_id`
5. 套用本機 D1 migration：`npm run d1:migrate:local`
6. 啟動本機開發：`npm run dev`
7. 部署前檢查：
   - `npm run deploy:dry-run:staging`
   - `npm run deploy:dry-run:production`
8. 正式部署：
   - `npm run deploy:staging`
   - `npm run deploy:production`

## Cloudflare 正式部署流程
1. 先登入 Cloudflare：`npx wrangler login`
2. 建立 staging D1：
   - `npx wrangler d1 create mobile-ledger-staging`
   - 把回傳的 `database_id` 填進 [wrangler.jsonc](/Users/user/tmp/project/mobile_ledger/wrangler.jsonc) 的 `env.staging.d1_databases`
3. 建立 production D1：
   - `npx wrangler d1 create mobile-ledger-production`
   - 把回傳的 `database_id` 填進 [wrangler.jsonc](/Users/user/tmp/project/mobile_ledger/wrangler.jsonc) 的 `env.production.d1_databases`
4. 寫入 staging secrets：
   - `npx wrangler secret put GOOGLE_CLIENT_ID --env staging`
   - `npx wrangler secret put GOOGLE_CLIENT_SECRET --env staging`
   - `npx wrangler secret put SESSION_SECRET --env staging`
5. 寫入 production secrets：
   - `npx wrangler secret put GOOGLE_CLIENT_ID --env production`
   - `npx wrangler secret put GOOGLE_CLIENT_SECRET --env production`
   - `npx wrangler secret put SESSION_SECRET --env production`
6. 套用遠端 migration：
   - `npm run d1:migrate:staging`
   - `npm run d1:migrate:production`
7. 最後部署：
   - `npm run deploy:staging`
   - `npm run deploy:production`

## Google OAuth Redirect URI 對應
1. 本機開發：
   - `http://127.0.0.1:8787/auth/google/callback`
2. staging：
   - `https://staging-mobile-ledger.example.workers.dev/auth/google/callback`
3. production：
   - `https://mobile-ledger.example.workers.dev/auth/google/callback`
4. 如果你改成自訂網域，`APP_BASE_URL` 與 Google OAuth redirect URI 也要一起改成同一組正式網址。

## 靜態資產同步
1. 目前編輯來源仍是 repo 根目錄的 [index.html](/Users/user/tmp/project/mobile_ledger/index.html)
2. 部署前會自動把它同步到 `public/index.html`
3. `npm run dev` 與 `npm run deploy` 都會先執行 `npm run sync:assets`

## 安全與可靠性說明
1. 已修補使用者輸入直接插入 HTML 的 XSS 風險（改為安全 DOM API 寫入）。
2. 已加入 CSV 公式注入防護（匯出欄位若以 `= + - @` 開頭會自動防護）。
3. 已補上連結 `rel="noopener noreferrer"`，降低 `target="_blank"` 風險。
4. 已加上資料正規化流程，避免異常資料破壞畫面渲染。
5. 前端已移除直接持有 Google API Key / OAuth 邏輯，避免憑證散落在 `index.html`。

## Google 雲端自動備份設定（Google Drive 我的雲端硬碟）
1. 到 [Google Cloud Console](https://console.cloud.google.com/) 建立專案。
2. 啟用 `Google Drive API`。
3. 建立 OAuth 同意畫面（External/Internal 依需求）。
4. 建立 OAuth Client ID（Web application）。
5. 在 OAuth Client 設定：
   - `Authorized redirect URIs` 需加入 Worker callback，例如 `https://your-worker.example.com/auth/google/callback`
   - 本機開發可加入 `http://127.0.0.1:8787/auth/google/callback`
6. 將 Google 憑證放到 Worker 環境變數，不需要再修改前端 [index.html](/Users/user/tmp/project/mobile_ledger/index.html)。
7. 重新載入頁面後按「連線 Google 並啟用自動備份」。
8. 連線完成後：
   - 本機資料異動會自動備份到你的 Google Drive「我的雲端硬碟」中的 `Mobile Ledger Backup` 資料夾
   - 每次備份都會建立一個新的 timestamp JSON 檔，不會覆蓋前一筆
   - 備份檔可在 `drive.google.com` 直接看到
   - 目前備份檔內容為 JSON，並非另外做密碼學加密
   - 頁面會顯示目前連線中的 Google 帳號
   - 同一個瀏覽器重新整理頁面時，會透過後端 session 保持登入狀態
   - Worker 會用 D1 內的 refresh token 自動換新 access token，不需要每次重登
   - 若 session 過期、refresh token 失效，才需要重新登入
   - 可按「中斷自動同步並登出授權」清除本機自動同步狀態，並嘗試撤銷目前授權
   - 可從下拉選單挑選最近 15 筆雲端備份再執行還原
   - 也可手動按「立即同步到雲端」或「從雲端還原」

## 開發備註
1. 前端不再直接呼叫 Google SDK，也不再需要在頁面裡放 `Client ID` 或 `API Key`。
2. 若修改了根目錄的 [index.html](/Users/user/tmp/project/mobile_ledger/index.html)，要同步到靜態資產可執行 `npm run sync:assets`。
3. 若要部署到 Cloudflare，建議把 `.dev.vars` 內的值改成正式 secret 管理方式，不要提交到版本庫。
4. `wrangler` 的 `vars`、`secrets`、`d1_databases` 都不是自動繼承欄位，所以 `staging` 與 `production` 必須各自定義。

## 更新時間
#### 20250515 第一次上傳
#### 20250522 增加功能
1. 搜尋記錄
2. 收支分類圖表
3. 記帳紀錄分類，每個分類可摺疊/展開
4. 小修 input CSS

#### 20250606 調整功能
1. 新增按月份檢視記錄功能 (ChatGPT Codex)
2. 收支分類圖表依月份顯示 (ChatGPT Codex)
3. 調整版型
4. 新增可指定日期記錄 (ChatGPT Codex)

#### 20250613 增加
1. 5 分鐘未操作或頁面隱藏後再次回到前景超過同樣時間就重新整理 (ChatGPT Codex)

#### 20260401 安全與同步更新
1. 修補主要 XSS 風險與 CSV 公式注入風險
2. 優化統計與圖表計算流程
3. 新增 Google Drive 雲端自動備份與還原

#### 20260622 Cloudflare Worker OAuth 改版
1. Google OAuth 改由 Cloudflare Worker 後端處理
2. 前端移除 Google API Key 與 OAuth Client ID 設定
3. 新增 D1 session / refresh token 流程，重整頁面可維持登入
4. Google Drive 備份 API 改由 Worker 代理，備份檔仍存於使用者自己的 My Drive
