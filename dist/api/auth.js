/**
 * Qamqor Health Monitoring System
 * Serverless Authentication Endpoint: /api/auth
 * Handles secure admin authentication, rate-limiting, and HMAC session token issuance.
 */

import crypto from 'crypto';

// Configuration
const ADMIN_PASSWORD_HASH = crypto.createHash('sha256')
  .update('qamqor_clinical_salt_2026:2020')
  .digest('hex');

const TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || 'qamqor_admin_secret_key_v1_secure_salt_789456';
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000; // 5 minutes
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory rate limiting store (cleared after server restart, protects endpoints)
const rateLimitMap = new Map();

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return String(forwarded).split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'local_client';
}

function checkRateLimit(ip) {
  const record = rateLimitMap.get(ip);
  if (!record) return { allowed: true, remaining: MAX_ATTEMPTS };

  const now = Date.now();
  if (now > record.resetAt) {
    rateLimitMap.delete(ip);
    return { allowed: true, remaining: MAX_ATTEMPTS };
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    const minutesLeft = Math.ceil((record.resetAt - now) / 60000);
    return { allowed: false, minutesLeft, remaining: 0 };
  }

  return { allowed: true, remaining: MAX_ATTEMPTS - record.attempts };
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  const record = rateLimitMap.get(ip) || { attempts: 0, resetAt: now + LOCKOUT_MS };
  record.attempts++;
  record.resetAt = now + LOCKOUT_MS;
  rateLimitMap.set(ip, record);
  return MAX_ATTEMPTS - record.attempts;
}

function clearRateLimit(ip) {
  rateLimitMap.delete(ip);
}

function generateToken() {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + TOKEN_TTL_MS;
  const payload = `qamqor_admin:${issuedAt}:${expiresAt}`;
  const hmac = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}:${hmac}`).toString('base64');
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    const parts = decoded.split(':');
    if (parts.length !== 4) return false;

    const [role, issuedAtStr, expiresAtStr, hmac] = parts;
    if (role !== 'qamqor_admin') return false;

    const expiresAt = parseInt(expiresAtStr, 10);
    if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
      return false; // Expired
    }

    const payload = `${role}:${issuedAtStr}:${expiresAtStr}`;
    const expectedHmac = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');

    const expectedBuf = Buffer.from(expectedHmac, 'hex');
    const actualBuf = Buffer.from(hmac, 'hex');

    if (expectedBuf.length !== actualBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, actualBuf);
  } catch (e) {
    return false;
  }
}

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  // Parse body
  let body = {};
  try {
    if (typeof req.body === 'object' && req.body !== null) {
      body = req.body;
    } else {
      const buffers = [];
      for await (const chunk of req) {
        buffers.push(chunk);
      }
      const raw = Buffer.concat(buffers).toString('utf-8');
      body = raw ? JSON.parse(raw) : {};
    }
  } catch (err) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ success: false, error: 'Неверный JSON в теле запроса' }));
    return;
  }

  const clientIp = getClientIp(req);
  const action = body.action || (req.method === 'GET' ? 'verify' : 'login');

  // ACTION: VERIFY
  if (action === 'verify') {
    const authHeader = req.headers.authorization || '';
    const token = body.token || (authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader);

    if (verifyToken(token)) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ valid: true, user: 'Администратор QAMQOR' }));
    } else {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ valid: false, error: 'Сессия недействительна или истекла' }));
    }
    return;
  }

  // ACTION: LOGIN
  if (action === 'login') {
    const rateCheck = checkRateLimit(clientIp);
    if (!rateCheck.allowed) {
      res.statusCode = 429;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        success: false,
        error: `Превышено количество попыток входа. Доступ заблокирован на ${rateCheck.minutesLeft} мин.`
      }));
      return;
    }

    const inputPassword = String(body.password || '');
    const computedHash = crypto.createHash('sha256')
      .update(`qamqor_clinical_salt_2026:${inputPassword}`)
      .digest('hex');

    const expectedBuf = Buffer.from(ADMIN_PASSWORD_HASH, 'hex');
    const actualBuf = Buffer.from(computedHash, 'hex');

    const isMatch = (expectedBuf.length === actualBuf.length) && crypto.timingSafeEqual(expectedBuf, actualBuf);

    if (isMatch) {
      clearRateLimit(clientIp);
      const token = generateToken();
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        success: true,
        token,
        role: 'admin',
        user: 'Администратор QAMQOR',
        message: 'Авторизация успешна'
      }));
    } else {
      const remaining = recordFailedAttempt(clientIp);
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        success: false,
        error: remaining > 0
          ? `Неверный пароль. Осталось попыток: ${remaining}`
          : 'Превышено число попыток. Вход временно заблокирован на 5 минут.'
      }));
    }
    return;
  }

  res.statusCode = 400;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ success: false, error: 'Неизвестное действие' }));
}
