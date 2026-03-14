const crypto = require("crypto");

function decodeBase64Url(input) {
  if (!input) return "";
  const normalized = String(input).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function encodeBase64Url(input) {
  return Buffer.from(String(input), "utf8").toString("base64url");
}

function parseCookieHeader(cookieHeader) {
  const cookies = {};
  if (!cookieHeader || typeof cookieHeader !== "string") return cookies;

  for (const part of cookieHeader.split(";")) {
    const segment = String(part || "").trim();
    if (!segment) continue;
    const idx = segment.indexOf("=");
    if (idx <= 0) continue;
    const name = segment.slice(0, idx).trim();
    const value = segment.slice(idx + 1).trim();
    if (!name) continue;
    cookies[name] = decodeURIComponent(value);
  }

  return cookies;
}

function parseRoles(rawRoles) {
  if (Array.isArray(rawRoles)) return rawRoles.map((v) => String(v).trim()).filter(Boolean);
  if (typeof rawRoles === "string") return rawRoles.split(",").map((v) => v.trim()).filter(Boolean);
  return [];
}

function validateSharedSessionToken(token, sharedSecret) {
  if (!sharedSecret || !token || typeof token !== "string") {
    return { ok: false, reason: "missing_secret_or_token" };
  }

  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "invalid_format" };

  const [payloadPart, signaturePart] = parts;
  const expectedSig = crypto
    .createHmac("sha256", sharedSecret)
    .update(payloadPart)
    .digest("base64url");

  const expectedBuffer = Buffer.from(expectedSig);
  const receivedBuffer = Buffer.from(signaturePart);
  if (expectedBuffer.length !== receivedBuffer.length) return { ok: false, reason: "invalid_signature" };
  if (!crypto.timingSafeEqual(expectedBuffer, receivedBuffer)) return { ok: false, reason: "invalid_signature" };

  let payload;
  try {
    payload = JSON.parse(decodeBase64Url(payloadPart));
  } catch (_error) {
    return { ok: false, reason: "invalid_payload" };
  }

  const now = Math.floor(Date.now() / 1000);
  const exp = Number(payload?.exp || 0);
  if (!Number.isInteger(exp) || exp <= now) return { ok: false, reason: "expired" };

  const user = String(payload?.user || payload?.username || "").trim();
  if (!user) return { ok: false, reason: "missing_user" };

  return {
    ok: true,
    user,
    roles: parseRoles(payload?.roles)
  };
}

function signSsoToken(payload, secret) {
  const payloadPart = encodeBase64Url(JSON.stringify(payload));
  const signaturePart = crypto
    .createHmac("sha256", secret)
    .update(payloadPart)
    .digest("base64url");
  return `${payloadPart}.${signaturePart}`;
}

function buildRedirectUrl(baseUrl, tokenParamName, ssoToken) {
  const separator = String(baseUrl).includes("?") ? "&" : "?";
  return `${baseUrl}${separator}${encodeURIComponent(tokenParamName)}=${encodeURIComponent(ssoToken)}`;
}

function createSsoResponse({ targetUrl, tokenTtlSeconds, tokenSecret, tokenParamName, user, authSource }) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: user,
    user,
    iat: now,
    exp: now + tokenTtlSeconds,
    typ: "container-sso"
  };

  const ssoToken = signSsoToken(payload, tokenSecret);
  const url = buildRedirectUrl(targetUrl, tokenParamName, ssoToken);

  return {
    ok: true,
    url,
    ssoToken,
    token: ssoToken,
    session: ssoToken,
    expiresInSeconds: tokenTtlSeconds,
    authSource,
    tokenType: "signed-hmac-sha256"
  };
}

module.exports = {
  buildRedirectUrl,
  createSsoResponse,
  decodeBase64Url,
  parseCookieHeader,
  signSsoToken,
  validateSharedSessionToken
};
