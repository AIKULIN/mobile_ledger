const SESSION_COOKIE_NAME = "mobile_ledger_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const OAUTH_STATE_TTL_MS = 1000 * 60 * 10;
const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_DRIVE_FILES_ENDPOINT = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_DRIVE_UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/drive/v3/files";
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.file"
];
const CLOUD_BACKUP_FOLDER_NAME = "Mobile Ledger Backup";
const CLOUD_BACKUP_FILE_PREFIX = "mobile_ledger_backup_";
const CLOUD_BACKUP_FILE_SUFFIX = ".json";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({
        ok: true,
        service: "mobile-ledger-worker",
        now: new Date().toISOString()
      });
    }

    if (url.pathname === "/api/session" && request.method === "GET") {
      const session = await getSession(request, env);
      return json({
        authenticated: Boolean(session?.user),
        user: session?.user || null,
        googleConnected: Boolean(session?.user?.googleSub)
      });
    }

    if (url.pathname === "/auth/google/start" && request.method === "GET") {
      return handleGoogleStart(request, env);
    }

    if (url.pathname === "/auth/google/callback" && request.method === "GET") {
      return handleGoogleCallback(request, env);
    }

    if (url.pathname === "/auth/logout" && request.method === "POST") {
      return handleLogout(request, env);
    }

    if (url.pathname === "/api/backups" && request.method === "GET") {
      return handleListBackups(request, env);
    }

    if (url.pathname === "/api/backups" && request.method === "POST") {
      return handleCreateBackup(request, env);
    }

    if (url.pathname.startsWith("/api/backups/") && request.method === "GET") {
      return handleGetBackup(request, env, url.pathname.replace("/api/backups/", ""));
    }

    return env.ASSETS.fetch(request);
  }
};

async function handleGoogleStart(request, env) {
  requireGoogleEnv(env);

  const state = randomBase64Url(32);
  const codeVerifier = randomBase64Url(64);
  const codeChallenge = await createCodeChallenge(codeVerifier);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString();
  const returnTo = sanitizeReturnTo(new URL(request.url).searchParams.get("returnTo"));

  await env.DB.prepare(
    `INSERT INTO oauth_states (state, code_verifier, return_to, expires_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  )
    .bind(state, codeVerifier, returnTo, expiresAt, now)
    .run();

  const authUrl = new URL(GOOGLE_AUTH_ENDPOINT);
  authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", buildRedirectUri(request, env));
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("prompt", "consent");

  return Response.redirect(authUrl.toString(), 302);
}

async function handleGoogleCallback(request, env) {
  requireGoogleEnv(env);

  const url = new URL(request.url);
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";

  if (!code || !state) {
    return text("Missing OAuth code or state.", 400);
  }

  const oauthState = await consumeOAuthState(state, env);
  if (!oauthState) {
    return text("Invalid or expired OAuth state.", 400);
  }

  try {
    const tokenPayload = await exchangeCodeForTokens({
      code,
      codeVerifier: oauthState.code_verifier,
      env,
      request
    });

    const userInfo = await fetchGoogleUserInfo(tokenPayload.access_token);
    const user = await upsertUser({ env, userInfo, tokenPayload });
    const sessionToken = randomBase64Url(48);
    const sessionId = await hashToken(sessionToken, env.SESSION_SECRET);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

    await env.DB.prepare(
      `INSERT INTO sessions (id, user_id, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4)`
    )
      .bind(sessionId, user.id, expiresAt, now)
      .run();

    const response = Response.redirect(resolveReturnTo(url, oauthState.return_to), 302);
    response.headers.append("Set-Cookie", buildSessionCookie(request, sessionToken, expiresAt));
    return response;
  } catch (error) {
    return text(`Google OAuth failed: ${error.message}`, 500);
  }
}

async function handleLogout(request, env) {
  const cookieToken = getCookie(request, SESSION_COOKIE_NAME);
  if (cookieToken) {
    const sessionId = await hashToken(cookieToken, env.SESSION_SECRET);
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?1").bind(sessionId).run();
  }

  const response = json({ ok: true });
  response.headers.append("Set-Cookie", clearSessionCookie(request));
  return response;
}

async function handleListBackups(request, env) {
  const auth = await requireAuthContext(request, env);
  if (auth instanceof Response) return auth;

  const limit = Math.min(Number(new URL(request.url).searchParams.get("limit") || 15), 15);
  const folderId = await ensureDriveFolderId(auth.userRow, auth.accessToken, env);
  const files = await listDriveBackups(folderId, auth.accessToken, limit);

  return json({
    items: files
  });
}

async function handleCreateBackup(request, env) {
  const auth = await requireAuthContext(request, env);
  if (auth instanceof Response) return auth;

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, message: "Invalid JSON payload." }, 400);
  }

  if (!isValidBackupPayload(payload)) {
    return json({ ok: false, message: "Invalid backup payload." }, 400);
  }

  const folderId = await ensureDriveFolderId(auth.userRow, auth.accessToken, env);
  const file = await createDriveBackup(folderId, payload, auth.accessToken);

  return json({
    ok: true,
    item: file
  });
}

async function handleGetBackup(request, env, fileId) {
  const auth = await requireAuthContext(request, env);
  if (auth instanceof Response) return auth;

  if (!fileId) {
    return json({ ok: false, message: "Missing backup file id." }, 400);
  }

  const folderId = await ensureDriveFolderId(auth.userRow, auth.accessToken, env);
  const metadata = await getDriveFileMetadata(fileId, auth.accessToken);

  if (!metadata.parents?.includes(folderId)) {
    return json({ ok: false, message: "Backup not found." }, 404);
  }

  const payload = await downloadDriveBackup(fileId, auth.accessToken);
  return json({
    id: metadata.id,
    name: metadata.name,
    createdTime: metadata.createdTime,
    modifiedTime: metadata.modifiedTime,
    payload
  });
}

async function requireAuthContext(request, env) {
  requireGoogleEnv(env);
  const session = await getSession(request, env);
  if (!session?.user?.id) {
    return json({ ok: false, message: "Unauthorized." }, 401);
  }

  const userRow = await env.DB.prepare(
    `SELECT id, google_sub, email, name, picture, refresh_token, access_token,
            access_token_expires_at, drive_folder_id
     FROM users
     WHERE id = ?1`
  )
    .bind(session.user.id)
    .first();

  if (!userRow) {
    return json({ ok: false, message: "User not found." }, 401);
  }

  const accessToken = await ensureUserAccessToken(userRow, env);
  return {
    session,
    userRow,
    accessToken
  };
}

async function getSession(request, env) {
  const cookieToken = getCookie(request, SESSION_COOKIE_NAME);
  if (!cookieToken) return null;

  const sessionId = await hashToken(cookieToken, env.SESSION_SECRET);
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT
       s.id AS session_id,
       s.expires_at,
       u.id AS user_id,
       u.google_sub,
       u.email,
       u.name,
       u.picture
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = ?1 AND s.expires_at > ?2`
  )
    .bind(sessionId, now)
    .first();

  if (!row) return null;

  return {
    id: row.session_id,
    expiresAt: row.expires_at,
    user: {
      id: row.user_id,
      googleSub: row.google_sub,
      email: row.email,
      name: row.name,
      picture: row.picture
    }
  };
}

async function consumeOAuthState(state, env) {
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT state, code_verifier, return_to, expires_at
     FROM oauth_states
     WHERE state = ?1 AND expires_at > ?2`
  )
    .bind(state, now)
    .first();

  await env.DB.prepare("DELETE FROM oauth_states WHERE state = ?1").bind(state).run();
  return row || null;
}

async function upsertUser({ env, userInfo, tokenPayload }) {
  const now = new Date().toISOString();
  const expiresAt = tokenPayload.expires_in
    ? new Date(Date.now() + Number(tokenPayload.expires_in) * 1000).toISOString()
    : null;

  const existing = await env.DB.prepare(
    `SELECT id, refresh_token, drive_folder_id
     FROM users
     WHERE google_sub = ?1`
  )
    .bind(userInfo.sub)
    .first();

  const refreshToken = tokenPayload.refresh_token || existing?.refresh_token || null;

  if (existing) {
    await env.DB.prepare(
      `UPDATE users
       SET email = ?1,
           name = ?2,
           picture = ?3,
           refresh_token = ?4,
           access_token = ?5,
           access_token_expires_at = ?6,
           updated_at = ?7
       WHERE id = ?8`
    )
      .bind(
        userInfo.email || "",
        userInfo.name || "",
        userInfo.picture || "",
        refreshToken,
        tokenPayload.access_token || null,
        expiresAt,
        now,
        existing.id
      )
      .run();

    return { id: existing.id };
  }

  const result = await env.DB.prepare(
    `INSERT INTO users (
       google_sub,
       email,
       name,
       picture,
       refresh_token,
       access_token,
       access_token_expires_at,
       created_at,
       updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
  )
    .bind(
      userInfo.sub,
      userInfo.email || "",
      userInfo.name || "",
      userInfo.picture || "",
      refreshToken,
      tokenPayload.access_token || null,
      expiresAt,
      now,
      now
    )
    .run();

  return { id: result.meta.last_row_id };
}

async function ensureUserAccessToken(userRow, env) {
  const expiresAt = userRow.access_token_expires_at ? Date.parse(userRow.access_token_expires_at) : 0;
  const now = Date.now();
  const isUsable = userRow.access_token && expiresAt - now > 60 * 1000;

  if (isUsable) {
    return userRow.access_token;
  }

  if (!userRow.refresh_token) {
    throw new Error("Missing refresh token for Google Drive access.");
  }

  const tokenPayload = await refreshGoogleAccessToken(userRow.refresh_token, env);
  const nextExpiresAt = tokenPayload.expires_in
    ? new Date(Date.now() + Number(tokenPayload.expires_in) * 1000).toISOString()
    : null;

  await env.DB.prepare(
    `UPDATE users
     SET access_token = ?1,
         access_token_expires_at = ?2,
         refresh_token = COALESCE(?3, refresh_token),
         updated_at = ?4
     WHERE id = ?5`
  )
    .bind(
      tokenPayload.access_token,
      nextExpiresAt,
      tokenPayload.refresh_token || null,
      new Date().toISOString(),
      userRow.id
    )
    .run();

  return tokenPayload.access_token;
}

async function ensureDriveFolderId(userRow, accessToken, env) {
  if (userRow.drive_folder_id) {
    return userRow.drive_folder_id;
  }

  let folder = await findDriveFolder(accessToken);
  if (!folder) {
    folder = await createDriveFolder(accessToken);
  }

  await env.DB.prepare(
    `UPDATE users
     SET drive_folder_id = ?1,
         updated_at = ?2
     WHERE id = ?3`
  )
    .bind(folder.id, new Date().toISOString(), userRow.id)
    .run();

  userRow.drive_folder_id = folder.id;
  return folder.id;
}

async function listDriveBackups(folderId, accessToken, limit = 15) {
  const url = new URL(GOOGLE_DRIVE_FILES_ENDPOINT);
  url.searchParams.set("q", `name contains '${CLOUD_BACKUP_FILE_PREFIX}' and '${folderId}' in parents and trashed=false`);
  url.searchParams.set("fields", "files(id,name,createdTime,modifiedTime,size)");
  url.searchParams.set("orderBy", "createdTime desc");
  url.searchParams.set("pageSize", String(limit));

  const payload = await googleApiJson(url.toString(), accessToken);
  return payload.files || [];
}

async function findDriveFolder(accessToken) {
  const url = new URL(GOOGLE_DRIVE_FILES_ENDPOINT);
  url.searchParams.set("q", `name='${CLOUD_BACKUP_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  url.searchParams.set("fields", "files(id,name)");
  url.searchParams.set("pageSize", "1");

  const payload = await googleApiJson(url.toString(), accessToken);
  return payload.files?.[0] || null;
}

async function createDriveFolder(accessToken) {
  return googleApiJson(GOOGLE_DRIVE_FILES_ENDPOINT, accessToken, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: CLOUD_BACKUP_FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder"
    })
  });
}

async function createDriveBackup(folderId, payload, accessToken) {
  const timestamp = payload.updatedAt || new Date().toISOString();
  const metadata = {
    name: buildBackupFileName(timestamp),
    parents: [folderId]
  };
  const boundary = "mobile-ledger-boundary";
  const body =
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(payload) +
    `\r\n--${boundary}--`;

  return googleApiJson(`${GOOGLE_DRIVE_UPLOAD_ENDPOINT}?uploadType=multipart&fields=id,name,createdTime,modifiedTime`, accessToken, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/related; boundary=${boundary}`
    },
    body
  });
}

async function getDriveFileMetadata(fileId, accessToken) {
  const url = new URL(`${GOOGLE_DRIVE_FILES_ENDPOINT}/${fileId}`);
  url.searchParams.set("fields", "id,name,parents,createdTime,modifiedTime");
  return googleApiJson(url.toString(), accessToken);
}

async function downloadDriveBackup(fileId, accessToken) {
  const url = new URL(`${GOOGLE_DRIVE_FILES_ENDPOINT}/${fileId}`);
  url.searchParams.set("alt", "media");
  return googleApiJson(url.toString(), accessToken);
}

async function exchangeCodeForTokens({ code, codeVerifier, env, request }) {
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: buildRedirectUri(request, env)
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || "Failed to exchange OAuth code.");
  }

  return payload;
}

async function refreshGoogleAccessToken(refreshToken, env) {
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || "Failed to refresh Google access token.");
  }

  return payload;
}

async function fetchGoogleUserInfo(accessToken) {
  const response = await fetch(GOOGLE_USERINFO_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || "Failed to fetch Google user info.");
  }

  return payload;
}

async function googleApiJson(url, accessToken, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {})
    }
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error?.message || payload.error_description || payload.error || "Google API request failed.");
  }

  return payload;
}

function buildRedirectUri(request, env) {
  const requestUrl = new URL(request.url);
  const baseUrl = env.APP_BASE_URL || requestUrl.origin;
  return `${baseUrl}/auth/google/callback`;
}

function resolveReturnTo(url, returnTo) {
  if (returnTo && returnTo.startsWith("/")) {
    return returnTo;
  }
  return `${url.origin}/`;
}

function sanitizeReturnTo(returnTo) {
  if (returnTo && returnTo.startsWith("/")) {
    return returnTo;
  }
  return "/";
}

function requireGoogleEnv(env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.SESSION_SECRET) {
    throw new Error("Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or SESSION_SECRET binding.");
  }
}

function buildBackupFileName(timestamp) {
  const safeTimestamp = String(timestamp || new Date().toISOString())
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${CLOUD_BACKUP_FILE_PREFIX}${safeTimestamp}${CLOUD_BACKUP_FILE_SUFFIX}`;
}

function isValidBackupPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (!Array.isArray(payload.entries)) return false;
  if (!payload.categories || typeof payload.categories !== "object") return false;
  if (!Array.isArray(payload.categories.income)) return false;
  if (!Array.isArray(payload.categories.expense)) return false;
  return true;
}

function buildSessionCookie(request, sessionToken, expiresAt) {
  const secure = new URL(request.url).protocol === "https:";
  const securePart = secure ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=${sessionToken}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Lax${securePart}`;
}

function clearSessionCookie(request) {
  const secure = new URL(request.url).protocol === "https:";
  const securePart = secure ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${securePart}`;
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return "";

  const cookies = cookieHeader.split(";").map(part => part.trim());
  for (const cookie of cookies) {
    const [key, ...rest] = cookie.split("=");
    if (key === name) {
      return rest.join("=");
    }
  }
  return "";
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function text(message, status = 200) {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8"
    }
  });
}

function randomBase64Url(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

function toBase64Url(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function createCodeChallenge(codeVerifier) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier)
  );
  return toBase64Url(new Uint8Array(digest));
}

async function hashToken(token, secret) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${secret}:${token}`)
  );
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}
