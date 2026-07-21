import rateLimit from "express-rate-limit";
import { logError } from "../services/errorLogService.js";

// Basic protection against abuse of the Groq proxy endpoint.
export const chatRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down and try again shortly." },
  handler: (req, res, next, options) => {
    logError({
      category: "rate_limit",
      message: "Chat rate limit exceeded",
      path: req.path,
      ip: req.ip,
      statusCode: options.statusCode,
    }).catch(() => {});
    res.status(options.statusCode).json(options.message);
  },
});

// Tighter limiter on the admin login endpoint to slow down brute-force attempts.
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per 15 min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again later." },
  handler: (req, res, next, options) => {
    logError({
      category: "auth",
      message: "Admin login rate limit exceeded",
      path: req.path,
      ip: req.ip,
      statusCode: options.statusCode,
    }).catch(() => {});
    res.status(options.statusCode).json(options.message);
  },
});

// General-purpose limiter for admin API endpoints (already behind JWT auth,
// this is a secondary layer against token abuse/scripted scraping).
export const adminApiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." },
});
