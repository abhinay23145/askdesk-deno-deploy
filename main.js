import {
  buildTask,
  formatRecentTasks,
  formatTaskStatus,
  formatTelegramReply,
  isAskDeskHeartbeatFresh,
  normalizeText,
  splitTask,
} from "./logic.js";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

export class MemoryStore {
  constructor() {
    this.items = new Map();
  }

  async getJson(key) {
    const value = this.items.get(key);
    if (value === undefined) return null;
    return JSON.parse(JSON.stringify(value));
  }

  async putJson(key, value) {
    this.items.set(key, JSON.parse(JSON.stringify(value)));
  }

  async delete(key) {
    this.items.delete(key);
  }

  async listKeys(prefix, limit = 100) {
    return [...this.items.keys()].filter((key) => key.startsWith(prefix)).slice(0, limit);
  }
}

export class DenoKvStore {
  constructor(kv) {
    this.kv = kv;
  }

  static async open() {
    return new DenoKvStore(await globalThis.Deno.openKv());
  }

  async getJson(key) {
    const entry = await this.kv.get(kvKey(key));
    return entry.value ?? null;
  }

  async putJson(key, value) {
    await this.kv.set(kvKey(key), value);
  }

  async delete(key) {
    await this.kv.delete(kvKey(key));
  }

  async listKeys(prefix, limit = 100) {
    const type = prefixType(prefix);
    const wanted = prefix.slice(type.length + 1);
    const keys = [];
    const iterator = this.kv.list({ prefix: ["hermes-lite", type] }, { limit: Math.max(limit, 100) });
    for await (const entry of iterator) {
      const id = String(entry.key[2] || "");
      const key = `${type}:${id}`;
      if (!wanted || id.startsWith(wanted)) keys.push(key);
      if (keys.length >= limit) break;
    }
    return keys;
  }
}

let defaultStorePromise = null;

export async function handleRequest(request, runtime = {}) {
  const store = runtime.store || await defaultStore();
  const env = runtime.env || envFromDeno();
  const fetchImpl = runtime.fetchImpl || fetch;
  return createApp({ store, env, fetchImpl })(request);
}

export function createApp({ store = new MemoryStore(), env = {}, fetchImpl = fetch } = {}) {
  return async function app(request) {
    try {
      return await routeRequest(request, { store, env, fetchImpl });
    } catch (error) {
      return json({ ok: false, error: publicError(error) }, error?.status || 500);
    }
  };
}

async function routeRequest(request, runtime) {
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);

  if (request.method === "GET" && path === "/health") {
    return json({
      ok: true,
      service: "hermes-lite",
      mode: "deno-deploy",
      kv_bound: true,
      telegram_configured: Boolean(envValue(runtime.env, "TELEGRAM_BOT_TOKEN")),
      askdesk_token_configured: Boolean(envValue(runtime.env, "ASKDESK_TOKEN")),
      model_configured: Boolean(envValue(runtime.env, "MODEL_API_BASE_URL") && envValue(runtime.env, "MODEL_API_KEY") && modelNames(runtime.env).length),
    });
  }

  if (request.method === "POST" && path === "/telegram/webhook") {
    return handleTelegramWebhook(request, runtime);
  }

  if (request.method === "POST" && path === "/askdesk/heartbeat") {
    requireAskDeskAuth(request, runtime.env);
    const payload = await request.json();
    const heartbeat = compactHeartbeat(payload);
    await putJson(runtime.store, "askdesk:heartbeat", heartbeat);
    return json({ ok: true, stored: true, heartbeat });
  }

  if (request.method === "GET" && path === "/askdesk/tasks") {
    requireAskDeskAuth(request, runtime.env);
    const limit = clampInt(url.searchParams.get("limit"), 1, 20, 5);
    const tasks = await claimAskDeskTasks(runtime.store, limit);
    return json({ ok: true, tasks });
  }

  if (request.method === "GET" && path === "/askdesk/debug/kv") {
    requireAskDeskAuth(request, runtime.env);
    const taskId = normalizeTaskId(url.searchParams.get("task") || "");
    return json({
      ok: true,
      queue_keys: await listKeysSafe(runtime.store, "queue:", 20),
      task_keys: await listKeysSafe(runtime.store, "task:", 20),
      queue_index: await getJsonSafe(runtime.store, queueIndexKey()),
      exact_queue: taskId ? await getJsonSafe(runtime.store, queueKey(taskId)) : null,
      exact_task: taskId ? await getJsonSafe(runtime.store, taskKey(taskId)) : null,
    });
  }

  const resultMatch = path.match(/^\/askdesk\/tasks\/([a-zA-Z0-9_-]+)\/result$/);
  if (request.method === "POST" && resultMatch) {
    requireAskDeskAuth(request, runtime.env);
    const taskId = resultMatch[1];
    const result = await request.json();
    const task = await getTask(runtime.store, taskId);
    if (!task) return json({ ok: false, error: "task not found" }, 404);
    task.status = result.status || (result.ok === false || result.success === false ? "failed" : "completed");
    task.updated_at = new Date().toISOString();
    task.result = result;
    task.summary = result.summary || task.summary || "";
    task.done_now = result.done_now || task.done_now || [];
    task.waiting_for = result.waiting_for || [];
    task.next_action = Object.prototype.hasOwnProperty.call(result, "next_action") ? result.next_action : defaultResultNextAction(task.status);
    await putTask(runtime.store, task);
    await runtime.store.delete(queueKey(task.id));
    await removeFromQueueIndex(runtime.store, task.id);
    await maybeSendTelegram(runtime, task.chat_id, formatResultMessage(task));
    return json({ ok: true, task });
  }

  if (request.method === "POST" && path === "/tasks") {
    requireAdminAuth(request, runtime.env);
    const payload = await request.json();
    const requestText = normalizeText(payload.request || payload.task || "");
    if (!requestText) return json({ ok: false, error: "request is required" }, 400);
    const heartbeat = await getJson(runtime.store, "askdesk:heartbeat");
    const askdeskOnline = isAskDeskHeartbeatFresh(heartbeat);
    const split = splitTask(requestText, askdeskOnline);
    const cloudSummary = await runCloudSteps(runtime, split);
    const task = buildTask({ request: requestText, split, chatId: payload.chat_id || "", source: payload.source || "api", cloudSummary });
    await putTask(runtime.store, task);
    if (task.needs_askdesk) await enqueueAskDeskTask(runtime.store, task);
    return json({ ok: true, task });
  }

  const taskMatch = path.match(/^\/tasks\/([a-zA-Z0-9_-]+)$/);
  if (request.method === "GET" && taskMatch) {
    requireAdminOrAskDeskAuth(request, runtime.env);
    const task = await getTask(runtime.store, taskMatch[1]);
    return task ? json({ ok: true, task }) : json({ ok: false, error: "task not found" }, 404);
  }

  return json({ ok: false, error: "not found" }, 404);
}

async function handleTelegramWebhook(request, runtime) {
  requireTelegramSecret(request, runtime.env);
  const update = await request.json();
  const message = update.message || update.edited_message || {};
  const chat = message.chat || {};
  const chatId = chat.id;
  const attachments = telegramAttachments(message);
  const text = normalizeText(message.text || message.caption || "");
  if (!chatId || (!text && !attachments.length)) return json({ ok: true, ignored: true });

  if (!allowedChat(runtime.env, chatId)) {
    await maybeSendTelegram(runtime, chatId, "Unauthorized chat. This Hermes-lite bot ignores unknown users.");
    return json({ ok: true, ignored: true, reason: "unauthorized_chat" });
  }

  if (text === "/start" || text === "/help") {
    await maybeSendTelegram(runtime, chatId, helpText());
    return json({ ok: true, command: "help" });
  }
  if (text === "/status") {
    const heartbeat = await getJson(runtime.store, "askdesk:heartbeat");
    const online = isAskDeskHeartbeatFresh(heartbeat);
    await maybeSendTelegram(runtime, chatId, `Hermes-lite online.\nAskDesk laptop: ${online ? "online" : "offline"}.\nSend a task in normal words or /run <task>.`);
    return json({ ok: true, command: "status" });
  }
  const taskStatusMatch = text.match(/^\/(?:task|status)\s+([a-zA-Z0-9_-]{4,64})$/i);
  if (taskStatusMatch) {
    const task = await findTaskForChat(runtime.store, chatId, taskStatusMatch[1]);
    await maybeSendTelegram(
      runtime,
      chatId,
      task ? formatTaskStatus(task) : `Task ${taskStatusMatch[1]} not found for this Telegram chat. Use /recent to see latest tasks.`,
    );
    return json({ ok: true, command: "task_status", found: Boolean(task) });
  }
  const recentMatch = text.match(/^\/recent(?:\s+(\d{1,2}))?$/i);
  if (recentMatch) {
    const limit = clampInt(recentMatch[1], 1, 8, 5);
    const tasks = await listRecentTasksForChat(runtime.store, chatId, limit);
    await maybeSendTelegram(runtime, chatId, formatRecentTasks(tasks));
    return json({ ok: true, command: "recent", count: tasks.length });
  }

  await maybeSendChatAction(runtime, chatId, "typing");
  const requestText = normalizeText(text.toLowerCase().startsWith("/run ") ? text.slice(5).trim() : text) || defaultAttachmentRequest(attachments);
  const heartbeat = await getJson(runtime.store, "askdesk:heartbeat");
  const askdeskOnline = isAskDeskHeartbeatFresh(heartbeat);
  const split = splitTask(requestText, askdeskOnline);
  const cloudSummary = await runCloudSteps(runtime, split);
  const task = buildTask({ request: requestText, split, chatId, source: "telegram", cloudSummary, attachments });
  await putTask(runtime.store, task);
  if (task.needs_askdesk) {
    await enqueueAskDeskTask(runtime.store, task);
  }
  if (!task.needs_askdesk || !askdeskOnline) {
    await maybeSendTelegram(runtime, chatId, formatTelegramReply(task));
  }
  return json({ ok: true, task_id: task.id, status: task.status });
}

async function claimAskDeskTasks(store, limit) {
  const indexedIds = await getQueueIndex(store);
  const tasks = [];
  const seenTaskIds = new Set();
  const removeTaskIds = new Set();
  for (const taskId of indexedIds) {
    if (tasks.length >= limit) break;
    const keyName = queueKey(taskId);
    const queueItem = (await getJson(store, keyName)) || {};
    if (queueItem.claimed_until && Date.now() < Number(queueItem.claimed_until)) {
      seenTaskIds.add(taskId);
      continue;
    }
    seenTaskIds.add(taskId);
    const task = await getTask(store, taskId);
    const claimed = await claimTaskForAskDesk(store, task, queueItem, keyName);
    if (!claimed) {
      await store.delete(keyName);
      removeTaskIds.add(taskId);
      continue;
    }
    tasks.push(claimed);
  }
  if (removeTaskIds.size) {
    await putJson(store, queueIndexKey(), indexedIds.filter((taskId) => !removeTaskIds.has(taskId)));
  }
  if (tasks.length >= limit) return tasks;

  if (tasks.length < limit) {
    await repairMissingQueueItems(store, limit - tasks.length);
    const fallback = await listKeysSafe(store, "task:", 100);
    for (const keyName of fallback) {
      if (tasks.length >= limit) break;
      const task = await getJsonSafe(store, keyName);
      if (!isClaimableAskDeskTask(task) || seenTaskIds.has(task.id)) continue;
      const claimed = await claimTaskForAskDesk(store, task, {}, queueKey(task.id));
      if (claimed) tasks.push(claimed);
    }
  }
  return tasks;
}

async function claimTaskForAskDesk(store, task, queueItem, keyName) {
  if (!isClaimableAskDeskTask(task)) return null;
  task.status = "askdesk_running";
  task.updated_at = new Date().toISOString();
  task.waiting_for = [];
  task.next_action = "AskDesk is running the laptop-local steps.";
  await putTask(store, task);
  await putJson(store, keyName, {
    task_id: task.id,
    created_at: queueItem.created_at || task.created_at,
    claimed_at: new Date().toISOString(),
    claimed_until: Date.now() + 120000,
    attempts: Number(queueItem.attempts || 0) + 1,
  });
  return {
    task_id: task.id,
    request: task.request,
    status: task.status,
    askdesk_steps: task.askdesk_steps,
    hermes_steps: task.hermes_steps || [],
    attachments: task.attachments || [],
    done_now: task.done_now || [],
    summary: task.summary || "",
    source: task.source || "telegram",
    chat_id: task.chat_id || "",
  };
}

async function enqueueAskDeskTask(store, task) {
  await putJson(store, queueKey(task.id), { task_id: task.id, created_at: task.created_at, attempts: 0 });
  await addToQueueIndex(store, task.id);
}

function isClaimableAskDeskTask(task) {
  if (!task?.needs_askdesk || !task.askdesk_steps?.length || task.result) return false;
  if (["completed", "failed"].includes(task.status)) return false;
  return true;
}

async function repairMissingQueueItems(store, maxItems = 5) {
  const listed = await listKeysSafe(store, "task:", 50);
  let repaired = 0;
  for (const keyName of listed) {
    if (repaired >= maxItems) return;
    const task = await getJsonSafe(store, keyName);
    if (!isClaimableAskDeskTask(task)) continue;
    const existingQueue = await getJson(store, queueKey(task.id));
    if (existingQueue) continue;
    await putJson(store, queueKey(task.id), {
      task_id: task.id,
      created_at: task.created_at,
      repaired_at: new Date().toISOString(),
      attempts: 0,
    });
    await addToQueueIndex(store, task.id);
    repaired += 1;
  }
}

async function findTaskForChat(store, chatId, taskIdOrPrefix) {
  const prefix = normalizeTaskId(taskIdOrPrefix);
  if (!prefix) return null;
  const exact = prefix.length > 12 ? await getTask(store, prefix) : null;
  if (exact && exact.chat_id === String(chatId)) return exact;

  const recentIds = await getRecentIndex(store, chatId);
  for (const taskId of recentIds) {
    if (!taskId.startsWith(prefix)) continue;
    const task = await getTask(store, taskId);
    if (task?.chat_id === String(chatId)) return task;
  }

  const listed = await listKeysSafe(store, taskKey(prefix), 10);
  for (const keyName of listed) {
    const task = await getJsonSafe(store, keyName);
    if (task?.chat_id === String(chatId)) return task;
  }
  return null;
}

async function listRecentTasksForChat(store, chatId, limit) {
  const indexedTasks = [];
  for (const taskId of await getRecentIndex(store, chatId)) {
    const task = await getTask(store, taskId);
    if (task?.chat_id === String(chatId)) indexedTasks.push(task);
    if (indexedTasks.length >= limit) return indexedTasks;
  }

  const listed = await listKeysSafe(store, "task:", 100);
  const tasks = [...indexedTasks];
  const seen = new Set(indexedTasks.map((task) => task.id));
  for (const keyName of listed) {
    const task = await getJsonSafe(store, keyName);
    if (task?.chat_id === String(chatId) && !seen.has(task.id)) {
      tasks.push(task);
      seen.add(task.id);
    }
  }
  return tasks
    .sort((left, right) => Date.parse(right.updated_at || right.created_at || 0) - Date.parse(left.updated_at || left.created_at || 0))
    .slice(0, limit);
}

async function runCloudSteps(runtime, split) {
  if (!split.hermes_steps?.length) return "";
  const baseUrl = envValue(runtime.env, "MODEL_API_BASE_URL");
  const apiKey = envValue(runtime.env, "MODEL_API_KEY");
  const models = modelNames(runtime.env);
  if (!(baseUrl && apiKey && models.length)) {
    return split.hermes_steps.length
      ? `Cloud side captured ${split.hermes_steps.length} step(s). Configure MODEL_API_* for deeper cloud reasoning/research.`
      : "";
  }
  const prompt = [
    "You are Hermes-lite. Complete only non-local cloud-safe planning/drafting/research steps.",
    "Do not claim laptop-local work is done.",
    "Answer the user's intent first. Be truthful about what was actually verified.",
    "Use compact sections only when useful.",
    "Give suggestions only when the user asks for them, when work is blocked/failed/risky, or when advice clearly helps the current document/task.",
    "If suggestions are not needed, do not add a Suggestions or Next steps section.",
    "If sources/proof are requested, name the evidence used or say no verified source is connected.",
    "Do not raw-dump text unless the user explicitly asks for raw text.",
    "Return one concise Telegram-ready summary.",
    "",
    ...split.hermes_steps.map((step, index) => `${index + 1}. ${step.text}`),
  ].join("\n");
  const failures = [];
  for (const model of models) {
    const response = await runtime.fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.25,
        max_tokens: 500,
      }),
    });
    if (!response.ok) {
      failures.push(`${model}: HTTP ${response.status}`);
      continue;
    }
    const payload = await response.json();
    const content = normalizeText(payload?.choices?.[0]?.message?.content || "");
    if (content) return content;
    failures.push(`${model}: empty response`);
  }
  const detail = failures.length ? ` (${failures.slice(0, 3).join("; ")})` : "";
  return `Cloud side captured ${split.hermes_steps.length} step(s), but model call failed${detail}.`;
}

function modelNames(env) {
  const names = [];
  for (const item of [envValue(env, "MODEL_NAME"), ...envValue(env, "MODEL_FALLBACK_NAMES").split(",")]) {
    const name = String(item || "").trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names.slice(0, 5);
}

async function maybeSendTelegram(runtime, chatId, text) {
  const token = envValue(runtime.env, "TELEGRAM_BOT_TOKEN");
  if (!token || !chatId || !text) return;
  await runtime.fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3900) }),
  });
}

async function maybeSendChatAction(runtime, chatId, action = "typing") {
  const token = envValue(runtime.env, "TELEGRAM_BOT_TOKEN");
  if (!token || !chatId) return;
  await runtime.fetchImpl(`https://api.telegram.org/bot${token}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action }),
  });
}

function telegramAttachments(message) {
  const attachments = [];
  if (message.document?.file_id) {
    attachments.push({
      type: "telegram_document",
      file_id: String(message.document.file_id),
      file_unique_id: String(message.document.file_unique_id || ""),
      file_name: String(message.document.file_name || "telegram-document"),
      mime_type: String(message.document.mime_type || ""),
      file_size: Number(message.document.file_size || 0),
    });
  }
  return attachments;
}

function defaultAttachmentRequest(attachments) {
  const first = attachments?.[0] || {};
  const name = String(first.file_name || "attached document");
  return `read attached document ${name}`;
}

function formatResultMessage(task) {
  if (task.status === "completed" && isPolishedAnswer(task.summary)) {
    return task.summary.slice(0, 3900);
  }

  const lines = [task.status === "completed" ? `Done ${task.id.slice(0, 8)}.` : `Task ${task.id.slice(0, 8)}: ${task.status}`];
  if (task.summary) lines.push(task.summary);
  const proof = task.result?.proof || task.result?.task?.proof || [];
  const media = task.result?.telegram_media || {};
  if (Number(media.sent || 0) > 0) {
    lines.push("Proof: image sent directly by AskDesk.");
  } else if (task.result?.downloaded_attachments?.length) {
    lines.push("Proof: attached document processed by AskDesk.");
  } else if (proof.length) {
    if (proofRequested(task)) {
      lines.push("Proof:");
      for (const item of proof.slice(0, 4)) lines.push(`- ${item.value || item.path || item.type || "proof"}`);
    } else {
      lines.push("Proof: saved in the AskDesk task record.");
    }
  }
  const nextAction = cleanNextAction(task.next_action);
  if (nextAction) lines.push(`Next: ${nextAction}`);
  return lines.join("\n");
}

function isPolishedAnswer(summary) {
  const text = String(summary || "").trim();
  if (!text) return false;
  return /^(Resume Review:|Document Brief\b|Answer:|Quick verdict:|Source-verified answer)/i.test(text);
}

function defaultResultNextAction(status) {
  if (status === "completed") return "";
  if (status === "failed") return "inspect error and decide retry or user follow-up";
  return "check task status";
}

function cleanNextAction(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^report result to (telegram|user)$/i.test(text)) return "";
  return text;
}

function proofRequested(task) {
  return /\b(proof|source|sources|evidence|path|where|verify|verified|truth)\b/i.test(`${task.request || ""} ${task.summary || ""}`);
}

function allowedChat(env, chatId) {
  const allowed = envValue(env, "TELEGRAM_ALLOWED_CHAT_IDS")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return allowed.includes(String(chatId));
}

function requireTelegramSecret(request, env) {
  const expected = envValue(env, "TELEGRAM_WEBHOOK_SECRET");
  if (!expected) return;
  const provided = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (provided !== expected) throw statusError("invalid telegram webhook secret", 401);
}

function requireAskDeskAuth(request, env) {
  const token = envValue(env, "ASKDESK_TOKEN");
  if (!token) throw statusError("ASKDESK_TOKEN is not configured", 500);
  requireBearer(request, token, "invalid AskDesk token");
}

function requireAdminAuth(request, env) {
  const token = envValue(env, "ADMIN_TOKEN");
  if (!token) throw statusError("ADMIN_TOKEN is not configured", 500);
  requireBearer(request, token, "invalid admin token");
}

function requireAdminOrAskDeskAuth(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (token && (token === envValue(env, "ADMIN_TOKEN") || token === envValue(env, "ASKDESK_TOKEN"))) return;
  throw statusError("invalid token", 401);
}

function requireBearer(request, expected, message) {
  const header = request.headers.get("Authorization") || "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token || token !== expected) throw statusError(message, 401);
}

function getTask(store, taskId) {
  return getJson(store, taskKey(taskId));
}

function putTask(store, task) {
  return putJson(store, taskKey(task.id), task).then(() => addToRecentIndex(store, task));
}

async function getJson(store, key) {
  return await store.getJson(key);
}

async function getJsonSafe(store, key) {
  try {
    return await getJson(store, key);
  } catch {
    return null;
  }
}

async function putJson(store, key, value) {
  await store.putJson(key, value);
}

async function listKeysSafe(store, prefix, limit) {
  try {
    return await store.listKeys(prefix, limit);
  } catch {
    return [];
  }
}

function taskKey(taskId) {
  return `task:${taskId}`;
}

function queueKey(taskId) {
  return `queue:${taskId}`;
}

function queueIndexKey() {
  return "queue:index";
}

function recentIndexKey(chatId) {
  return `recent:${chatId}`;
}

async function getQueueIndex(store) {
  const index = await getJsonSafe(store, queueIndexKey());
  return Array.isArray(index) ? index.map(normalizeTaskId).filter(Boolean).slice(0, 200) : [];
}

async function addToQueueIndex(store, taskId) {
  const id = normalizeTaskId(taskId);
  if (!id) return;
  const existing = await getQueueIndex(store);
  await putJson(store, queueIndexKey(), [id, ...existing.filter((item) => item !== id)].slice(0, 200));
}

async function removeFromQueueIndex(store, taskId) {
  const id = normalizeTaskId(taskId);
  if (!id) return;
  const existing = await getQueueIndex(store);
  await putJson(store, queueIndexKey(), existing.filter((item) => item !== id));
}

async function getRecentIndex(store, chatId) {
  const index = await getJsonSafe(store, recentIndexKey(chatId));
  return Array.isArray(index) ? index.map(normalizeTaskId).filter(Boolean).slice(0, 100) : [];
}

async function addToRecentIndex(store, task) {
  if (!task?.id || !task.chat_id) return;
  const existing = await getRecentIndex(store, task.chat_id);
  await putJson(store, recentIndexKey(task.chat_id), [task.id, ...existing.filter((item) => item !== task.id)].slice(0, 50));
}

function normalizeTaskId(value) {
  return String(value || "")
    .replace(/^task:/i, "")
    .trim();
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

function normalizePath(pathname) {
  const path = pathname.replace(/\/+$/g, "");
  return path || "/";
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function helpText() {
  return [
    "Hermes-lite online.",
    "Send normal task text or /run <task>.",
    "I do cloud-safe work now and queue laptop-local work for AskDesk.",
    "Use /status to check whether AskDesk laptop is online.",
    "Use /recent to list recent tasks.",
    "Use /task <id> or /status <id> to inspect a task.",
  ].join("\n");
}

function statusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function publicError(error) {
  return String(error?.message || error || "unknown error").slice(0, 500);
}

function envFromDeno() {
  return {
    TELEGRAM_BOT_TOKEN: envValue({}, "TELEGRAM_BOT_TOKEN"),
    TELEGRAM_ALLOWED_CHAT_IDS: envValue({}, "TELEGRAM_ALLOWED_CHAT_IDS"),
    TELEGRAM_WEBHOOK_SECRET: envValue({}, "TELEGRAM_WEBHOOK_SECRET"),
    ASKDESK_TOKEN: envValue({}, "ASKDESK_TOKEN"),
    ADMIN_TOKEN: envValue({}, "ADMIN_TOKEN"),
    MODEL_API_BASE_URL: envValue({}, "MODEL_API_BASE_URL"),
    MODEL_API_KEY: envValue({}, "MODEL_API_KEY"),
    MODEL_NAME: envValue({}, "MODEL_NAME"),
    MODEL_FALLBACK_NAMES: envValue({}, "MODEL_FALLBACK_NAMES"),
  };
}

function compactHeartbeat(payload = {}) {
  const queue = isPlainObject(payload.queue) ? payload.queue : {};
  const modelStatus = isPlainObject(payload.model_status) ? payload.model_status : {};
  const recentTasks = Array.isArray(payload.recent_tasks) ? payload.recent_tasks.slice(0, 3).map(compactRecentTask) : [];
  const capabilityList = Array.isArray(payload.capability_list)
    ? payload.capability_list.map((item) => String(item).slice(0, 80)).slice(0, 40)
    : Object.entries(isPlainObject(payload.capabilities) ? payload.capabilities : {})
        .filter(([, enabled]) => Boolean(enabled))
        .map(([name]) => String(name).slice(0, 80))
        .slice(0, 40);
  return {
    ok: payload.ok !== false,
    service: "askdesk",
    online: true,
    version: String(payload.version || "").slice(0, 40),
    workspace: String(payload.workspace || "").slice(0, 240),
    timestamp: Math.floor(Date.now() / 1000),
    received_at: new Date().toISOString(),
    load: String(payload.load || "idle").slice(0, 40),
    capability_list: capabilityList,
    queue: {
      running_count: Number(queue.running_count || 0),
      pending_count: Number(queue.pending_count || 0),
      completed_count: Number(queue.completed_count || 0),
      failed_count: Number(queue.failed_count || 0),
    },
    model_status: {
      usable: Boolean(modelStatus.usable),
      provider: String(modelStatus.provider || modelStatus.current_provider || "").slice(0, 80),
      model: String(modelStatus.model || modelStatus.current_model || "").slice(0, 120),
      ladder: Array.isArray(modelStatus.ladder) ? modelStatus.ladder.map((item) => String(item).slice(0, 80)).slice(0, 10) : [],
    },
    recent_tasks: recentTasks,
  };
}

function compactRecentTask(task = {}) {
  return {
    id: String(task.id || "").slice(0, 80),
    status: String(task.status || "").slice(0, 40),
    request: String(task.request || "").slice(0, 200),
    summary: String(task.summary || task.error || "").slice(0, 240),
    updated_at: String(task.updated_at || task.created_at || "").slice(0, 80),
  };
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function envValue(env, name) {
  if (env && Object.prototype.hasOwnProperty.call(env, name)) return String(env[name] || "");
  if (globalThis.Deno?.env?.get) return globalThis.Deno.env.get(name) || "";
  return "";
}

async function defaultStore() {
  if (!defaultStorePromise) {
    defaultStorePromise = DenoKvStore.open();
  }
  return await defaultStorePromise;
}

function kvKey(key) {
  if (key === "askdesk:heartbeat") return ["hermes-lite", "askdesk", "heartbeat"];
  const type = prefixType(key);
  const id = key.slice(type.length + 1);
  return ["hermes-lite", type, id];
}

function prefixType(key) {
  const match = String(key || "").match(/^([a-zA-Z0-9_-]+):/);
  return match ? match[1] : "misc";
}

if (globalThis.Deno?.serve && import.meta.main) {
  globalThis.Deno.serve((request) => handleRequest(request));
}
