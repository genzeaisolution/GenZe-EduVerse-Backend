import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import {
  ADMIN_USERNAME,
  ADMIN_PASSWORD_HASH,
  JWT_SECRET,
  JWT_EXPIRES_IN,
} from "../config/adminConfig.js";
import { logAudit } from "../services/auditLogService.js";
import { logError } from "../services/errorLogService.js";
import { getClientIp } from "../services/visitorService.js";
import { logAuth, logErrorEvent } from "../utils/logger.js";

/**
 * POST /api/auth/login
 * Validates credentials against env-configured username + bcrypt hash,
 * then issues a short-lived JWT. Credentials are NEVER hard-coded or
 * exposed to the client — only the resulting signed token is returned.
 */
export async function login(req, res) {
  const ip = getClientIp(req);

  try {
    if (!ADMIN_USERNAME || !ADMIN_PASSWORD_HASH || !JWT_SECRET) {
      return res.status(503).json({ error: "Admin panel is not configured on this server." });
    }

    const { username, password } = req.body || {};

    if (!username || !password || typeof username !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "Username and password are required." });
    }

    // Constant-time-ish comparison: always run bcrypt.compare even on username
    // mismatch, so response timing doesn't leak whether the username was valid.
    const usernameMatches = username === ADMIN_USERNAME;
    const passwordMatches = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);

    if (!usernameMatches || !passwordMatches) {
      await logAudit({ admin: username, action: "ADMIN_LOGIN_FAILED", ip });
      logAuth({
        severity: "warn",
        event: "LOGIN_FAILED",
        message: `Failed admin login attempt for username "${username}"`,
        meta: { ip },
      });
      return res.status(401).json({ error: "Invalid username or password." });
    }

    const token = jwt.sign({ username, role: "admin" }, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN,
    });

    await logAudit({ admin: username, action: "ADMIN_LOGIN", ip });
    logAuth({ event: "LOGIN_SUCCESS", message: `Admin "${username}" logged in.`, meta: { ip } });

    res.json({
      token,
      expiresIn: JWT_EXPIRES_IN,
      admin: { username },
    });
  } catch (err) {
    await logError({ category: "auth", message: err.message, path: req.path, ip, statusCode: 500 });
    logErrorEvent({ event: "LOGIN_ERROR", message: err.message, meta: { ip } });
    res.status(500).json({ error: "Login failed. Please try again." });
  }
}

/**
 * POST /api/auth/logout
 * Stateless JWT — logout is primarily client-side (token discarded), but we
 * still record the audit event for traceability.
 */
export async function logout(req, res) {
  const ip = getClientIp(req);
  await logAudit({ admin: req.admin?.username, action: "ADMIN_LOGOUT", ip });
  logAuth({ event: "LOGOUT", message: `Admin "${req.admin?.username}" logged out.`, meta: { ip } });
  res.json({ message: "Logged out successfully." });
}

/** GET /api/auth/verify — lets the frontend confirm a stored token is still valid. */
export async function verify(req, res) {
  res.json({ valid: true, admin: req.admin });
}
