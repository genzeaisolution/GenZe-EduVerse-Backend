import { getSettings } from "../services/settingsService.js";
import { submitFeedback } from "../services/feedbackService.js";

/** GET /api/settings — public, read-only organization info for the frontend. */
export function getPublicSettings(req, res) {
  res.json(getSettings());
}

/** POST /api/feedback — students can submit feedback/suggestions/bug reports. */
export async function submitFeedbackHandler(req, res) {
  try {
    const { type, message, email } = req.body || {};
    const entry = await submitFeedback({ type, message, email, sessionId: req.sessionId });
    res.status(201).json({ message: "Thanks for your feedback!", id: entry.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
