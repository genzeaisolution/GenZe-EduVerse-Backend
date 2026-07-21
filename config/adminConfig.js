import dotenv from "dotenv";
dotenv.config();

/**
 * Admin authentication configuration.
 *
 * SECURITY: Credentials are NEVER hard-coded here or in frontend code.
 * - ADMIN_USERNAME comes straight from the environment.
 * - ADMIN_PASSWORD_HASH is a bcrypt hash of the real password, generated once
 *   with `node utils/generatePasswordHash.js "yourPassword"` and stored in .env.
 *   The plaintext password is never persisted anywhere on disk.
 * - JWT_SECRET signs the admin session token; rotate it to invalidate all sessions.
 */
export const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "";
export const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || "";
export const JWT_SECRET = process.env.JWT_SECRET || "";
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "8h";

// Fail loudly on boot in production if critical secrets are missing.
export function assertAdminConfig() {
  const missing = [];
  if (!ADMIN_USERNAME) missing.push("ADMIN_USERNAME");
  if (!ADMIN_PASSWORD_HASH) missing.push("ADMIN_PASSWORD_HASH");
  if (!JWT_SECRET) missing.push("JWT_SECRET");

  if (missing.length) {
    console.warn(
      `⚠️  Admin panel is DISABLED — missing env vars: ${missing.join(", ")}. ` +
        `See backend/.env.example and utils/generatePasswordHash.js to configure it.`
    );
  }
  return missing.length === 0;
}
