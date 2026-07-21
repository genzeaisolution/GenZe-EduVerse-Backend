import Groq from "groq-sdk";
import dotenv from "dotenv";

dotenv.config();

// Single shared Groq client instance used across the backend.
// The API key never leaves the server (never exposed to frontend).
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
  timeout: 60_000, // fail fast rather than hang the client on a stuck request
  maxRetries: 2,   // groq-sdk built-in retry for transient network/5xx errors
});

// Primary text model — strong reasoning, good for step-by-step academic work.
export const TEXT_MODEL = process.env.GROQ_TEXT_MODEL || "llama-3.3-70b-versatile";

// Backup text model used automatically if the primary model errors out or is
// unavailable, so a single model outage doesn't take down the whole app.
export const TEXT_MODEL_FALLBACK =
  process.env.GROQ_TEXT_MODEL_FALLBACK || "llama-3.1-8b-instant";

// Vision-capable model for image understanding (OCR, diagrams, handwriting, charts).
export const VISION_MODEL =
  process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";

// Backup vision model.
export const VISION_MODEL_FALLBACK =
  process.env.GROQ_VISION_MODEL_FALLBACK || "meta-llama/llama-4-maverick-17b-128e-instruct";

export default groq;
