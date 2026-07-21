import { getVisitorStats } from "../services/visitorService.js";
import { readCollection } from "../services/storage.js";
import {
  getChatLogs,
  deleteChatLog,
  getAllChatLogsForExport,
} from "../services/chatLogService.js";
import { getErrorLogs } from "../services/errorLogService.js";
import { getAuditLogs, logAudit } from "../services/auditLogService.js";
import { getSettings, updateSettings } from "../services/settingsService.js";
import { getClientIp } from "../services/visitorService.js";
import {
  queryLogs,
  getLogCategorySummary,
  exportLogsAsText,
  deleteLogFile,
} from "../services/logFileService.js";
import {
  getActivePrompt,
  getPromptHistory,
  createPromptVersion,
  restorePromptVersion,
} from "../services/promptService.js";
import { getAiConfig, updateAiConfig } from "../services/aiConfigService.js";
import { getFeedback, updateFeedback, getAllFeedbackForExport } from "../services/feedbackService.js";
import { getKeyPoolStatus, KEY_POOL_SIZE } from "../services/apiKeyManager.js";
import { LOG_CATEGORIES } from "../utils/logger.js";

const SERVER_START_TIME = Date.now();

function formatUptime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

/** GET /api/admin/dashboard */
export async function getDashboardStats(req, res) {
  const visitorStats = getVisitorStats();
  const chatLogs = readCollection("chatLogs");
  const errorLogs = readCollection("errorLogs");

  const uptimeMs = Date.now() - SERVER_START_TIME;

  const today = new Date().toISOString().slice(0, 10);
  const todayChats = chatLogs.filter((c) => c.timestamp.slice(0, 10) === today);
  const monthStart = new Date();
  monthStart.setDate(1);
  const monthlyActiveSessions = new Set(
    chatLogs.filter((c) => new Date(c.timestamp) >= monthStart).map((c) => c.sessionId)
  ).size;
  const dailyActiveSessions = new Set(todayChats.map((c) => c.sessionId)).size;

  const visionRequests = chatLogs.filter((c) => c.hadImage).length;
  const durationsWithValue = chatLogs.filter((c) => typeof c.durationMs === "number");
  const avgResponseTimeMs = durationsWithValue.length
    ? Math.round(durationsWithValue.reduce((sum, c) => sum + c.durationMs, 0) / durationsWithValue.length)
    : 0;

  const totalTokens = chatLogs.reduce((sum, c) => sum + (c.tokenUsage?.total_tokens || 0), 0);
  const errorRate = chatLogs.length
    ? Math.round((errorLogs.length / (chatLogs.length + errorLogs.length)) * 100)
    : 0;

  await logAudit({ admin: req.admin?.username, action: "VIEW_LOGS", details: "dashboard", ip: getClientIp(req) });

  res.json({
    // Visitors / sessions (this app has no user accounts — "users" = unique browser sessions)
    totalVisitors: visitorStats.totalVisitors,
    todayVisitors: visitorStats.todayVisitors,
    activeUsers: visitorStats.activeUsers,
    dailyActiveSessions,
    monthlyActiveSessions,
    totalPageViews: visitorStats.totalPageViews,

    // AI usage
    totalQuestions: chatLogs.length,
    totalAiRequests: chatLogs.length,
    todayAiRequests: todayChats.length,
    visionRequests,
    ocrRequests: visionRequests, // every vision request in this pipeline includes OCR-style extraction
    avgResponseTimeMs,
    totalTokensUsed: totalTokens,

    // Health
    totalErrors: errorLogs.length,
    errorRatePercent: errorRate,
    backendStatus: "online",
    apiStatus: process.env.GROQ_API_KEY ? "configured" : "missing_api_key",
    serverUptime: formatUptime(uptimeMs),
    serverUptimeMs: uptimeMs,
    nodeVersion: process.version,
    timestamp: new Date().toISOString(),
  });
}

/** GET /api/admin/logs/visitors */
export async function getVisitorLogs(req, res) {
  const { page = 1, limit = 25 } = req.query;
  const logs = readCollection("visitorLogs");
  const start = (page - 1) * limit;
  const paged = logs.slice(start, start + Number(limit));

  await logAudit({ admin: req.admin?.username, action: "VIEW_LOGS", details: "visitor_logs", ip: getClientIp(req) });

  res.json({ total: logs.length, page: Number(page), limit: Number(limit), logs: paged });
}

/** GET /api/admin/logs/chats */
export async function getChatLogsHandler(req, res) {
  const { search, from, to, page = 1, limit = 25 } = req.query;
  const result = getChatLogs({ search, from, to, page, limit });

  await logAudit({ admin: req.admin?.username, action: "VIEW_LOGS", details: "chat_logs", ip: getClientIp(req) });

  res.json(result);
}

/** DELETE /api/admin/logs/chats/:id */
export async function deleteChatLogHandler(req, res) {
  const { id } = req.params;
  const deleted = await deleteChatLog(id);

  if (!deleted) {
    return res.status(404).json({ error: "Chat log not found." });
  }

  await logAudit({
    admin: req.admin?.username,
    action: "DELETE_CHAT_LOG",
    details: id,
    ip: getClientIp(req),
  });

  res.json({ message: "Chat log deleted." });
}

/** GET /api/admin/logs/chats/export — exports all chat logs as CSV. */
export async function exportChatLogsHandler(req, res) {
  const logs = getAllChatLogsForExport();

  const header = "id,sessionId,question,answer,hadImage,model,timestamp\n";
  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""').replace(/\n/g, " ")}"`;
  const rows = logs
    .map((l) =>
      [l.id, l.sessionId, escape(l.question), escape(l.answer), l.hadImage, l.model, l.timestamp].join(",")
    )
    .join("\n");

  await logAudit({ admin: req.admin?.username, action: "EXPORT_CHAT_LOGS", ip: getClientIp(req) });

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=chat-logs.csv");
  res.send(header + rows);
}

/** GET /api/admin/logs/errors */
export async function getErrorLogsHandler(req, res) {
  const { category, page = 1, limit = 25 } = req.query;
  const result = getErrorLogs({ category, page, limit });

  await logAudit({ admin: req.admin?.username, action: "VIEW_LOGS", details: "error_logs", ip: getClientIp(req) });

  res.json(result);
}

/** GET /api/admin/logs/audit */
export async function getAuditLogsHandler(req, res) {
  const { page = 1, limit = 25 } = req.query;
  const result = getAuditLogs({ page, limit });
  res.json(result);
}

/** GET /api/admin/reports?range=daily|weekly|monthly */
export async function getReports(req, res) {
  const { range = "daily" } = req.query;
  const chatLogs = readCollection("chatLogs");
  const visitorLogs = readCollection("visitorLogs");

  const rangeMs = { daily: 1, weekly: 7, monthly: 30 }[range] * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - rangeMs;

  const recentChats = chatLogs.filter((l) => new Date(l.timestamp).getTime() >= cutoff);
  const recentVisitors = visitorLogs.filter((l) => new Date(l.timestamp).getTime() >= cutoff);

  // Naive "top subjects" heuristic based on keyword matching in questions.
  const subjectKeywords = {
    Mathematics: ["math", "algebra", "calculus", "geometry", "equation"],
    "Computer Science": ["code", "program", "javascript", "python", "algorithm", "function"],
    Physics: ["physics", "force", "energy", "velocity", "motion"],
    Chemistry: ["chemistry", "reaction", "molecule", "element", "compound"],
    Biology: ["biology", "cell", "organism", "gene", "dna"],
    Business: ["business", "marketing", "finance", "economics", "accounting"],
    History: ["history", "war", "century", "revolution", "ancient"],
    English: ["essay", "grammar", "literature", "poem", "writing"],
  };
  const subjectCounts = {};
  for (const chat of recentChats) {
    const text = chat.question.toLowerCase();
    for (const [subject, keywords] of Object.entries(subjectKeywords)) {
      if (keywords.some((k) => text.includes(k))) {
        subjectCounts[subject] = (subjectCounts[subject] || 0) + 1;
      }
    }
  }
  const topSubjects = Object.entries(subjectCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([subject, count]) => ({ subject, count }));

  const avgResponseTime =
    recentChats.filter((c) => c.durationMs).reduce((sum, c) => sum + c.durationMs, 0) /
      (recentChats.filter((c) => c.durationMs).length || 1) || 0;

  // Most active day within the range.
  const dayCounts = {};
  for (const chat of recentChats) {
    const day = chat.timestamp.slice(0, 10);
    dayCounts[day] = (dayCounts[day] || 0) + 1;
  }
  const mostActiveDay =
    Object.entries(dayCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  res.json({
    range,
    totalVisitors: new Set(recentVisitors.map((v) => v.sessionId)).size,
    questionsAsked: recentChats.length,
    topSubjects,
    averageResponseTimeMs: Math.round(avgResponseTime),
    mostActiveDay,
    generatedAt: new Date().toISOString(),
  });
}

/** GET /api/admin/settings (admin view) */
export async function getSettingsHandler(req, res) {
  res.json(getSettings());
}

/** PUT /api/admin/settings */
export async function updateSettingsHandler(req, res) {
  const updated = await updateSettings(req.body || {});

  await logAudit({
    admin: req.admin?.username,
    action: "UPDATE_SETTINGS",
    details: JSON.stringify(req.body),
    ip: getClientIp(req),
  });

  res.json(updated);
}

// =====================================================================================
// PHASE 2 — System Logs Viewer (reads Phase 1's logs/<category>/<date>.log files)
// =====================================================================================

/** GET /api/admin/system-logs/summary */
export async function getSystemLogsSummary(req, res) {
  res.json({ categories: LOG_CATEGORIES, summary: getLogCategorySummary() });
}

/** GET /api/admin/system-logs/:category */
export async function getSystemLogsHandler(req, res) {
  const { category } = req.params;
  const { search, severity, event, from, to, page = 1, limit = 50 } = req.query;

  if (!LOG_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `Unknown log category "${category}".` });
  }

  const result = queryLogs(category, { search, severity, event, from, to, page, limit });
  await logAudit({
    admin: req.admin?.username,
    action: "VIEW_LOGS",
    details: `system_logs:${category}`,
    ip: getClientIp(req),
  });
  res.json(result);
}

/** GET /api/admin/system-logs/:category/export */
export async function exportSystemLogsHandler(req, res) {
  const { category } = req.params;
  if (!LOG_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `Unknown log category "${category}".` });
  }
  const text = exportLogsAsText(category);
  await logAudit({
    admin: req.admin?.username,
    action: "EXPORT_LOGS",
    details: category,
    ip: getClientIp(req),
  });
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Content-Disposition", `attachment; filename=${category}-logs.ndjson`);
  res.send(text);
}

/** DELETE /api/admin/system-logs/:category/:date */
export async function deleteSystemLogHandler(req, res) {
  const { category, date } = req.params;
  try {
    const deleted = deleteLogFile(category, date);
    if (!deleted) return res.status(404).json({ error: "Log file not found." });
    await logAudit({
      admin: req.admin?.username,
      action: "DELETE_LOG_FILE",
      details: `${category}/${date}`,
      ip: getClientIp(req),
    });
    res.json({ message: "Log file deleted." });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

// =====================================================================================
// PHASE 2 — AI Logs Panel (rich view over chatLogs: subject, model, tokens, fallback)
// =====================================================================================

/** GET /api/admin/ai-logs */
export async function getAiLogsHandler(req, res) {
  const { search, subject, model, from, to, page = 1, limit = 25 } = req.query;
  let logs = readCollection("chatLogs");

  if (search) {
    const q = search.toLowerCase();
    logs = logs.filter((l) => l.question.toLowerCase().includes(q) || l.answer.toLowerCase().includes(q));
  }
  if (subject) logs = logs.filter((l) => l.subject === subject);
  if (model) logs = logs.filter((l) => l.model === model);
  if (from) logs = logs.filter((l) => new Date(l.timestamp) >= new Date(from));
  if (to) logs = logs.filter((l) => new Date(l.timestamp) <= new Date(to));

  const total = logs.length;
  const start = (page - 1) * limit;
  const paged = logs.slice(start, start + Number(limit));

  await logAudit({ admin: req.admin?.username, action: "VIEW_LOGS", details: "ai_logs", ip: getClientIp(req) });

  res.json({ total, page: Number(page), limit: Number(limit), logs: paged });
}

// =====================================================================================
// PHASE 2 — Prompt Manager
// =====================================================================================

/** GET /api/admin/prompt */
export async function getPromptHandler(req, res) {
  res.json({ active: getActivePrompt(), history: getPromptHistory() });
}

/** PUT /api/admin/prompt */
export async function updatePromptHandler(req, res) {
  const { content, note } = req.body || {};
  try {
    const version = await createPromptVersion({ content, note, createdBy: req.admin?.username });
    await logAudit({
      admin: req.admin?.username,
      action: "PROMPT_CHANGED",
      details: note || "(no note)",
      ip: getClientIp(req),
    });
    res.json(version);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

/** POST /api/admin/prompt/:versionId/restore */
export async function restorePromptHandler(req, res) {
  const { versionId } = req.params;
  const restored = await restorePromptVersion(versionId);
  if (!restored) return res.status(404).json({ error: "Prompt version not found." });
  await logAudit({
    admin: req.admin?.username,
    action: "PROMPT_RESTORED",
    details: versionId,
    ip: getClientIp(req),
  });
  res.json(restored);
}

// =====================================================================================
// PHASE 2 — AI Model Management
// =====================================================================================

/** GET /api/admin/ai-config */
export async function getAiConfigHandler(req, res) {
  res.json(getAiConfig());
}

/** PUT /api/admin/ai-config */
export async function updateAiConfigHandler(req, res) {
  const updated = await updateAiConfig(req.body || {});
  await logAudit({
    admin: req.admin?.username,
    action: "MODEL_CONFIG_CHANGED",
    details: JSON.stringify(req.body),
    ip: getClientIp(req),
  });
  res.json(updated);
}

// =====================================================================================
// PHASE 2 — Feedback Management
// =====================================================================================

/** GET /api/admin/feedback */
export async function getFeedbackHandler(req, res) {
  const { status, type, page = 1, limit = 25 } = req.query;
  res.json(getFeedback({ status, type, page, limit }));
}

/** PATCH /api/admin/feedback/:id */
export async function updateFeedbackHandler(req, res) {
  const { id } = req.params;
  const updated = await updateFeedback(id, req.body || {});
  if (!updated) return res.status(404).json({ error: "Feedback item not found." });
  await logAudit({
    admin: req.admin?.username,
    action: "FEEDBACK_UPDATED",
    details: id,
    ip: getClientIp(req),
  });
  res.json(updated);
}

/** GET /api/admin/feedback/export */
export async function exportFeedbackHandler(req, res) {
  const items = getAllFeedbackForExport();
  const header = "id,type,status,message,email,sessionId,adminReply,createdAt\n";
  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""').replace(/\n/g, " ")}"`;
  const rows = items
    .map((i) =>
      [i.id, i.type, i.status, escape(i.message), i.email, i.sessionId, escape(i.adminReply), i.createdAt].join(",")
    )
    .join("\n");
  await logAudit({ admin: req.admin?.username, action: "EXPORT_FEEDBACK", ip: getClientIp(req) });
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=feedback.csv");
  res.send(header + rows);
}

// =====================================================================================
// PHASE 2 — Security Panel (failed logins, rejected tokens, rate-limit hits)
// =====================================================================================

/** GET /api/admin/security */
export async function getSecurityOverview(req, res) {
  const auditLogs = readCollection("auditLogs");
  const errorLogs = readCollection("errorLogs");

  const failedLogins = auditLogs.filter((a) => a.action === "ADMIN_LOGIN_FAILED").slice(0, 100);
  const authErrors = errorLogs.filter((e) => e.category === "auth").slice(0, 100);
  const rateLimitHits = errorLogs.filter((e) => e.category === "rate_limit").slice(0, 100);

  // Naive suspicious-IP heuristic: 5+ failed logins from the same IP.
  const ipCounts = {};
  for (const entry of failedLogins) {
    if (entry.ip) ipCounts[entry.ip] = (ipCounts[entry.ip] || 0) + 1;
  }
  const suspiciousIps = Object.entries(ipCounts)
    .filter(([, count]) => count >= 5)
    .map(([ip, count]) => ({ ip, failedAttempts: count }));

  await logAudit({ admin: req.admin?.username, action: "VIEW_LOGS", details: "security", ip: getClientIp(req) });

  res.json({
    failedLogins,
    authErrors,
    rateLimitHits,
    suspiciousIps,
    totalFailedLogins: failedLogins.length,
    totalAuthErrors: authErrors.length,
    totalRateLimitHits: rateLimitHits.length,
    apiKeyPool: { size: KEY_POOL_SIZE, keys: getKeyPoolStatus() },
  });
}

/** GET /api/admin/api-keys — dedicated key-pool health endpoint for the API Health page. */
export async function getApiKeyStatusHandler(req, res) {
  res.json({ size: KEY_POOL_SIZE, keys: getKeyPoolStatus() });
}

// =====================================================================================
// PHASE 2 — Backup / Export (JSON snapshot of all admin-visible collections)
// =====================================================================================

/** GET /api/admin/backup */
export async function createBackupHandler(req, res) {
  const backup = {
    generatedAt: new Date().toISOString(),
    chatLogs: readCollection("chatLogs"),
    errorLogs: readCollection("errorLogs"),
    auditLogs: readCollection("auditLogs"),
    visitorLogs: readCollection("visitorLogs"),
    feedback: readCollection("feedback"),
    promptVersions: readCollection("promptVersions"),
    settings: getSettings(),
    aiConfig: getAiConfig(),
  };
  await logAudit({ admin: req.admin?.username, action: "BACKUP_CREATED", ip: getClientIp(req) });
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename=genze-backup-${Date.now()}.json`);
  res.send(JSON.stringify(backup, null, 2));
}
