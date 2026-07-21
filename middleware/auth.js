import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../config/adminConfig.js";
import { logError } from "../services/errorLogService.js";
import { logAuth } from "../utils/logger.js";

/**
 * Protects admin routes. Expects a Bearer token in the Authorization header
 * (the frontend also mirrors it in an httpOnly-less localStorage token for
 * simplicity in this MVP — see SECURITY note in routes/auth.js).
 */
export async function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: "Authentication required." });
    }

    if (!JWT_SECRET) {
      return res.status(503).json({ error: "Admin panel is not configured on this server." });
    }

    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== "admin") {
      return res.status(403).json({ error: "Insufficient permissions." });
    }

    req.admin = { username: payload.username };
    next();
  } catch (err) {
    await logError({
      category: "auth",
      message: `Invalid/expired admin token: ${err.message}`,
      path: req.path,
      ip: req.ip,
      statusCode: 401,
    });
    logAuth({
      severity: "warn",
      event: "TOKEN_REJECTED",
      message: `Invalid/expired admin token: ${err.message}`,
      meta: { path: req.path, ip: req.ip },
    });
    return res.status(401).json({ error: "Invalid or expired session. Please log in again." });
  }
}
