import { logVisitor } from "../services/visitorService.js";
import { logApi } from "../utils/logger.js";

// Paths we don't want polluting visitor analytics (admin/internal/API health).
const EXCLUDED_PREFIXES = ["/api/admin", "/api/auth", "/api/health"];

/**
 * Fire-and-forget visitor logging for public-facing traffic.
 * Also attaches `req.sessionId` so downstream handlers (e.g. chat logging)
 * can correlate requests to the same browser session.
 */
export async function requestLogger(req, res, next) {
  const shouldSkip = EXCLUDED_PREFIXES.some((p) => req.path.startsWith(p));
  const startedAt = Date.now();

  if (!shouldSkip) {
    try {
      const { sessionId, isNewSession } = await logVisitor(req);
      req.sessionId = sessionId;
      if (isNewSession) {
        res.cookie("genze_session", sessionId, {
          httpOnly: true,
          sameSite: "lax",
          maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        });
      }
    } catch (err) {
      console.error("Visitor logging failed:", err.message);
    }
  }

  // Log every API request/response (method, path, status, duration) to logs/api,
  // regardless of whether it's excluded from visitor analytics.
  res.on("finish", () => {
    logApi({
      severity: res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
      event: "HTTP_REQUEST",
      message: `${req.method} ${req.originalUrl} -> ${res.statusCode}`,
      sessionId: req.sessionId,
      meta: { method: req.method, path: req.originalUrl, statusCode: res.statusCode, durationMs: Date.now() - startedAt },
    });
  });

  next();
}
