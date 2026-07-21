import {
  TEXT_MODEL as ENV_TEXT_MODEL,
  TEXT_MODEL_FALLBACK as ENV_TEXT_MODEL_FALLBACK,
  VISION_MODEL as ENV_VISION_MODEL,
  VISION_MODEL_FALLBACK as ENV_VISION_MODEL_FALLBACK,
} from "../config/groq.js";
import { callGroqWithFailover } from "../services/apiKeyManager.js";
import { getActivePrompt } from "../services/promptService.js";
import { getAiConfig } from "../services/aiConfigService.js";
import { detectSubject } from "../utils/subjectDetector.js";
import { logChatExchange } from "../services/chatLogService.js";
import { logError } from "../services/errorLogService.js";
import { getClientIp } from "../services/visitorService.js";
import {
  logAi,
  logVision,
  logOcr,
  logUpload,
  logPerformance,
  logErrorEvent,
} from "../utils/logger.js";

// ---------------------------------------------------------------------------------
// Phase 1 tuning constants
// ---------------------------------------------------------------------------------
// How many prior conversation messages (user+assistant turns) to send to the model.
// Keeps context memory intact for the active chat while bounding token usage/latency.
const MAX_HISTORY_MESSAGES = 20;

// A response taking longer than this is flagged as slow in performance logs.
const SLOW_RESPONSE_THRESHOLD_MS = 12_000;

const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB safety ceiling for base64 payloads

/**
 * Validates a base64 data-URL image: correct prefix, allowed mime type, size ceiling.
 * Returns an error string, or null if valid.
 */
function validateImage(image) {
  if (typeof image !== "string" || !image.startsWith("data:image/")) {
    return "Invalid image format.";
  }
  const mimeMatch = image.match(/^data:(image\/[a-zA-Z+]+);base64,/);
  if (!mimeMatch || !ALLOWED_IMAGE_TYPES.includes(mimeMatch[1])) {
    return "Unsupported image type. Please upload PNG, JPEG, WEBP, or GIF.";
  }
  const approxBytes = (image.length * 3) / 4;
  if (approxBytes > MAX_IMAGE_BYTES) {
    return "Image is too large. Please upload an image under 8MB.";
  }
  return { mimeType: mimeMatch[1], approxBytes };
}

/**
 * Trims conversation history to the most recent N messages so the model keeps working
 * context for the active chat without unbounded token growth.
 */
function trimHistory(messages) {
  if (messages.length <= MAX_HISTORY_MESSAGES) return messages;
  return messages.slice(messages.length - MAX_HISTORY_MESSAGES);
}

/**
 * Attempts to open a streaming completion with the given model, and transparently
 * falls back to a secondary model if the primary fails *before* any tokens are sent
 * to the client (e.g. model temporarily unavailable, rate-limited, etc.).
 */
async function createStreamWithFallback(conversation, primaryModel, fallbackModel, params, sessionId) {
  const makeRequest = (client, model) =>
    client.chat.completions.create({
      model,
      messages: conversation,
      temperature: params.temperature,
      top_p: params.top_p,
      max_tokens: params.max_tokens,
      stream: true,
    });

  try {
    const { result: stream, keyIndex } = await callGroqWithFailover(
      (client) => makeRequest(client, primaryModel),
      { requestType: "chat", model: primaryModel }
    );
    return { stream, modelUsed: primaryModel, usedFallback: false, keyIndex };
  } catch (primaryError) {
    logAi({
      severity: "warn",
      event: "MODEL_FALLBACK",
      message: `Primary model "${primaryModel}" unavailable across all keys, retrying with fallback "${fallbackModel}": ${primaryError?.message}`,
      sessionId,
    });
    const { result: stream, keyIndex } = await callGroqWithFailover(
      (client) => makeRequest(client, fallbackModel),
      { requestType: "chat", model: fallbackModel }
    );
    return { stream, modelUsed: fallbackModel, usedFallback: true, keyIndex };
  }
}

/**
 * Handles a chat completion request.
 * Supports plain text messages and optional image (base64 data URL) for vision.
 * Streams the response back to the client using chunked transfer encoding.
 */
export const handleChat = async (req, res) => {
  const requestStart = Date.now();
  const sessionId = req.sessionId;

  try {
    const { messages, image } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      await logError({
        category: "invalid_request",
        message: "Chat request missing messages array",
        path: req.path,
        ip: getClientIp(req),
        statusCode: 400,
      });
      logErrorEvent({
        event: "INVALID_REQUEST",
        message: "Chat request missing messages array",
        sessionId,
      });
      return res.status(400).json({ error: "messages array is required" });
    }

    let imageMeta = null;
    if (image) {
      const validation = validateImage(image);
      if (typeof validation === "string") {
        await logError({
          category: "image_upload",
          message: validation,
          path: req.path,
          ip: getClientIp(req),
          statusCode: 400,
        });
        logUpload({
          severity: "warn",
          event: "IMAGE_REJECTED",
          message: validation,
          sessionId,
        });
        return res.status(400).json({ error: validation });
      }
      imageMeta = validation;
      logUpload({
        event: "IMAGE_ACCEPTED",
        message: `Image accepted for analysis (${imageMeta.mimeType}, ~${Math.round(
          imageMeta.approxBytes / 1024
        )}KB)`,
        sessionId,
        meta: imageMeta,
      });
    }

    // Keep only well-formed user/assistant turns, and bound history length so context
    // memory stays intact for the active chat without unbounded token growth.
    const cleanTurns = messages.filter((m) => m.role === "user" || m.role === "assistant");
    const boundedTurns = trimHistory(cleanTurns);

    // Detect subject from the latest user message to tune generation parameters
    // (lower temperature for math/programming = more deterministic/correct answers).
    const lastUserContent = [...boundedTurns].reverse().find((m) => m.role === "user")?.content;
    const subject = detectSubject(typeof lastUserContent === "string" ? lastUserContent : "");

    // Live, admin-configurable AI parameters (Phase 2 Model Management), falling back
    // to env-configured defaults if no override has ever been saved.
    const aiConfig = getAiConfig();
    const params = {
      temperature: aiConfig.subjectTemperatures?.[subject] ?? aiConfig.defaultTemperature,
      top_p: aiConfig.defaultTopP,
      max_tokens: aiConfig.maxTokens,
    };

    logAi({
      event: "SUBJECT_DETECTED",
      message: `Detected subject "${subject}" — temperature=${params.temperature}`,
      sessionId,
      meta: { subject, params },
    });

    // Build the conversation, always led by the education-only, accuracy-focused system prompt.
    const conversation = [
      { role: "system", content: getActivePrompt() },
      ...boundedTurns.map((m) => ({ role: m.role, content: m.content })),
    ];

    let primaryModel = aiConfig.textModel || ENV_TEXT_MODEL;
    let fallbackModel = aiConfig.fallbackEnabled ? aiConfig.textModelFallback || ENV_TEXT_MODEL_FALLBACK : primaryModel;

    // If an image is attached to the latest user message, switch to a vision-capable
    // model and reformat the last message as multimodal content.
    if (image) {
      primaryModel = aiConfig.visionModel || ENV_VISION_MODEL;
      fallbackModel = aiConfig.fallbackEnabled
        ? aiConfig.visionModelFallback || ENV_VISION_MODEL_FALLBACK
        : primaryModel;
      const lastMsg = conversation[conversation.length - 1];
      conversation[conversation.length - 1] = {
        role: "user",
        content: [
          {
            type: "text",
            text:
              lastMsg.content ||
              "Please carefully read all visible text/content in this image (OCR), then answer based on it.",
          },
          { type: "image_url", image_url: { url: image } },
        ],
      };

      logVision({
        event: "VISION_REQUEST",
        message: `Vision request routed to "${primaryModel}"`,
        sessionId,
        meta: { model: primaryModel, mimeType: imageMeta.mimeType },
      });
      logOcr({
        event: "OCR_PIPELINE_START",
        message: "Requesting text/content extraction + reasoning from image via vision model.",
        sessionId,
      });
    }

    let stream, modelUsed, keyIndex;
    try {
      ({ stream, modelUsed, keyIndex } = await createStreamWithFallback(
        conversation,
        primaryModel,
        fallbackModel,
        params,
        sessionId
      ));
    } catch (bothFailedError) {
      logErrorEvent({
        event: bothFailedError?.allKeysExhausted ? "ALL_KEYS_EXHAUSTED" : "MODEL_UNAVAILABLE",
        message: `Both primary and fallback models failed: ${bothFailedError?.message}`,
        sessionId,
        meta: { primaryModel, fallbackModel },
      });
      await logError({
        category: "api",
        message: `Both models failed: ${bothFailedError?.message || bothFailedError}`,
        path: req.path,
        ip: getClientIp(req),
        statusCode: 503,
      });
      return res.status(503).json({
        error: bothFailedError?.allKeysExhausted
          ? "AI service daily limits have been reached. Please try again after the quota reset."
          : "I'm temporarily unable to reach the AI service. This isn't a guess-worthy situation — " +
            "please try again in a moment. If it persists, the AI provider may be experiencing an outage.",
      });
    }

    // Set headers for streaming plain text chunks to the client.
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("X-Model-Used", modelUsed);
    res.setHeader("X-Detected-Subject", subject);

    let clientAborted = false;
    req.on("close", () => {
      clientAborted = true;
    });

    let fullResponse = "";
    let usage = null;
    try {
      for await (const chunk of stream) {
        if (clientAborted) break;
        const token = chunk.choices?.[0]?.delta?.content || "";
        if (token) {
          fullResponse += token;
          res.write(token);
        }
        // Groq streams a final usage payload (prompt/completion token counts) on the
        // last chunk under `x_groq.usage` — capture it for token-efficiency logging.
        if (chunk.x_groq?.usage) usage = chunk.x_groq.usage;
      }
    } catch (streamError) {
      logErrorEvent({
        event: "STREAM_INTERRUPTED",
        message: streamError?.message || String(streamError),
        sessionId,
      });
      if (!clientAborted) {
        res.write(
          "\n\n_(The response was interrupted due to a connection issue. Please ask again if it seems incomplete.)_"
        );
      }
    }

    res.end();

    const durationMs = Date.now() - requestStart;

    if (image) {
      logOcr({
        event: "OCR_PIPELINE_COMPLETE",
        message: `Image analysis completed in ${durationMs}ms`,
        sessionId,
        meta: { durationMs, responseLength: fullResponse.length },
      });
    }

    logAi({
      event: "CHAT_RESPONSE",
      message: `Response generated using "${modelUsed}" in ${durationMs}ms (subject: ${subject})`,
      sessionId,
      meta: {
        model: modelUsed,
        subject,
        durationMs,
        hadImage: !!image,
        responseLength: fullResponse.length,
        tokenUsage: usage,
      },
    });

    logPerformance({
      severity: durationMs > SLOW_RESPONSE_THRESHOLD_MS ? "warn" : "info",
      event: "REQUEST_LATENCY",
      message: `Chat request completed in ${durationMs}ms${
        durationMs > SLOW_RESPONSE_THRESHOLD_MS ? " (SLOW)" : ""
      }`,
      sessionId,
      meta: { durationMs, model: modelUsed, hadImage: !!image, tokenUsage: usage },
    });

    // Persist the exchange for the admin Chat Logs panel (fire-and-forget, non-blocking).
    const lastUserMessage = messages[messages.length - 1];
    logChatExchange({
      sessionId,
      question: typeof lastUserMessage?.content === "string" ? lastUserMessage.content : "[image question]",
      answer: fullResponse,
      hadImage: !!image,
      model: modelUsed,
      durationMs,
      subject,
      tokenUsage: usage,
      usedFallback: modelUsed !== primaryModel,
    }).catch((err) => console.error("Failed to log chat exchange:", err.message));
  } catch (error) {
    console.error("Chat error:", error?.message || error);
    await logError({
      category: "api",
      message: error?.message || "Unknown chat error",
      path: req.path,
      ip: getClientIp(req),
      statusCode: 500,
    });
    logErrorEvent({
      event: "CHAT_HANDLER_EXCEPTION",
      message: error?.message || "Unknown chat error",
      sessionId,
      meta: { stack: error?.stack?.slice(0, 2000) },
    });
    if (!res.headersSent) {
      res.status(500).json({
        error:
          "Something went wrong while generating a response. Please try again — if the issue " +
          "continues, try rephrasing your question or splitting it into smaller parts.",
      });
    } else {
      res.end();
    }
  }
};

/**
 * Simple health check endpoint.
 */
export const healthCheck = (req, res) => {
  const aiConfig = getAiConfig();
  res.json({
    status: "ok",
    service: "GenZe EduVerse API",
    textModel: aiConfig.textModel || ENV_TEXT_MODEL,
    visionModel: aiConfig.visionModel || ENV_VISION_MODEL,
    timestamp: new Date().toISOString(),
  });
};
