## 這是一個簡易的手機記帳
1. 預設資料會儲存在目前瀏覽器（localStorage）。
2. 不建議在 Line 內建瀏覽器開啟，資料可能遺失。
3. 由於資料存在瀏覽器本機，用哪個瀏覽器建立資料，就要用同一個瀏覽器讀取。
4. 無痕模式不適用，資料不會保存。
5. 若清除瀏覽器資料，未備份的資料會遺失。
6. 本機資料是「Base64 編碼儲存（混淆）」，不是密碼學加密。

## 安全與可靠性說明
1. 已修補使用者輸入直接插入 HTML 的 XSS 風險（改為安全 DOM API 寫入）。
2. 已加入 CSV 公式注入防護（匯出欄位若以 `= + - @` 開頭會自動防護）。
3. 已補上連結 `rel="noopener noreferrer"`，降低 `target="_blank"` 風險。
4. 已加上資料正規化流程，避免異常資料破壞畫面渲染。

## Google 雲端自動備份設定（Google Drive 我的雲端硬碟）
1. 到 [Google Cloud Console](https://console.cloud.google.com/) 建立專案。
2. 啟用 `Google Drive API`。
3. 建立 OAuth 同意畫面（External/Internal 依需求）。
4. 建立 OAuth Client ID（Web application）。
5. 在 OAuth Client 設定 `Authorized JavaScript origins`：
   - 若本機開啟檔案：建議改用本機伺服器（如 `http://localhost:5500`）並填入該來源。
   - 若部署網站：填入你的正式網域來源（例如 `https://example.com`）。
6. 建立 API Key，並建議限制：
   - API 限制：只允許 `Google Drive API`
   - 應用限制：只允許你的 HTTP referrer
7. 打開 [index.html](/Users/user/tmp/project/mobile_ledger/index.html)：
   - 將 `GOOGLE_OAUTH_CLIENT_ID` 填入你的 Google OAuth Client ID
   - 將 `GOOGLE_API_KEY` 填入你的 Google API Key
   - 重新載入頁面後按「連線 Google 並啟用自動備份」
8. 連線完成後：
   - 本機資料異動會自動備份到你的 Google Drive「我的雲端硬碟」中的 `Mobile Ledger Backup` 資料夾
   - 每次備份都會建立一個新的 timestamp JSON 檔，不會覆蓋前一筆
   - 備份檔可在 `drive.google.com` 直接看到
   - 目前備份檔內容為 JSON，並非另外做密碼學加密
   - 頁面會顯示目前連線中的 Google 帳號
   - 同一個瀏覽器之後重新開啟頁面時，會先自動嘗試恢復 Google 授權狀態
   - 程式會記住上次成功連線的 Google 帳號，重整後用 `login_hint` 優先嘗試恢復同一帳號
   - 若 Google session 已失效、瀏覽器阻擋靜默授權，仍需要手動按一次「連線 Google 並啟用自動備份」
   - 可按「中斷自動同步並登出授權」清除本機自動同步狀態，並嘗試撤銷目前授權
   - 可從下拉選單挑選最近 15 筆雲端備份再執行還原
   - 也可手動按「立即同步到雲端」或「從雲端還原」

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
