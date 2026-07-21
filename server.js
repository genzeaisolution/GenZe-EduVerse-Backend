import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";

import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin.js";
import publicRoutes from "./routes/public.js";

import { requestLogger } from "./middleware/requestLogger.js";
import { sanitizeInput } from "./utils/sanitize.js";
import { assertAdminConfig } from "./config/adminConfig.js";
import { logError } from "./services/errorLogService.js";
import { logSystem, logErrorEvent } from "./utils/logger.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Required on Render/Cloudflare-style proxies so req.ip reflects the real client IP.
app.set("trust proxy", 1);

// Warn (non-fatal) if admin credentials aren't configured yet.
assertAdminConfig();

// Allow configuring multiple comma-separated origins for CORS.
const allowedOrigins = (process.env.CLIENT_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

// Increased body limit to allow base64 image uploads for vision requests.
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
app.use(sanitizeInput);

// Visitor analytics — runs on all public (non-admin/auth/health) requests.
app.use(requestLogger);

app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api", publicRoutes);

app.get("/", (req, res) => {
  res.json({ message: "GenZe EduVerse API is running 🚀" });
});

// Catch-all 404
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Global error handler — catches anything that slips past route-level try/catch.
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message);
  logError({
    category: "backend",
    message: err.message,
    path: req.path,
    ip: req.ip,
    statusCode: 500,
  }).catch(() => {});
  logErrorEvent({
    event: "UNHANDLED_EXCEPTION",
    message: err.message,
    meta: { path: req.path, ip: req.ip, stack: err.stack?.slice(0, 2000) },
  });
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Internal server error." });
});

// Catch process-level failures that slip past Express entirely.
process.on("unhandledRejection", (reason) => {
  logErrorEvent({
    event: "UNHANDLED_REJECTION",
    message: reason?.message || String(reason),
    meta: { stack: reason?.stack?.slice(0, 2000) },
  });
});
process.on("uncaughtException", (err) => {
  logErrorEvent({
    event: "UNCAUGHT_EXCEPTION",
    message: err.message,
    meta: { stack: err.stack?.slice(0, 2000) },
  });
});

const server = app.listen(PORT, () => {
  logSystem({
    event: "SERVER_STARTUP",
    message: `GenZe EduVerse backend running on port ${PORT}`,
    meta: { port: PORT, nodeEnv: process.env.NODE_ENV || "development" },
  });
});

// Graceful shutdown logging (Render/Docker send SIGTERM on redeploy/scale-down).
function gracefulShutdown(signal) {
  logSystem({ event: "SERVER_SHUTDOWN", message: `Received ${signal}, shutting down gracefully.` });
  server.close(() => process.exit(0));
  // Force-exit if connections don't close in time.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));