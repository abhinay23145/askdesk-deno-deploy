const LOCAL_PATTERNS = [
  /\baskdesk\b/i,
  /\bmy\s+(laptop|pc|computer|desktop|windows|machine)\b/i,
  /\b(this|local)\s+(laptop|pc|computer|desktop|windows|machine|folder|file|browser)\b/i,
  /\b(downloads|desktop|documents|pictures|screenshots|resume|cv)\s*(folder|file|doc|document)?\b/i,
  /\b(open|click|type|paste|screenshot|inspect|control)\b.*\b(browser|window|app|screen|desktop|ui)\b/i,
  /\b(upload|submit|apply|login|sign\s*in|fill|attach)\b/i,
  /\b(save|keep|store|remember|basket)\b.*\b(this|file|pdf|docx|document|attachment|resume|cv|job\s+link|link)\b/i,
  /\bbasket\b/i,
  /\b(use|using)\b.*\b(saved\s+)?(resume|cv|details|profile)\b.*\b(apply|job|career|opening)\b/i,
  /\b(word|excel|powerpoint|pdf|docx|xlsx|pptx)\b.*\b(open|edit|save|export|convert|read|inspect)\b/i,
  /\b(read|inspect|summarize|summarise|analyze|analyse|extract)\b.*\b(pdf|docx|xlsx|pptx|document|file|attachment)\b/i,
  /\b(run|execute|install|uninstall|delete|move|rename|copy)\b.*\b(file|folder|command|script|app|program)\b/i,
];

const NON_LOCAL_PATTERNS = [
  /\bresearch\b/i,
  /\bplan\b/i,
  /\bsummar(y|ize|ise)\b/i,
  /\bdraft\b/i,
  /\bwrite\b/i,
  /\bexplain\b/i,
  /\bcompare\b/i,
  /\bremember\b/i,
  /\bremind\b/i,
  /\bschedule\b/i,
  /\bcron\b/i,
  /\bthink\b/i,
  /\banaly[sz]e\b/i,
  /\bstrategy\b/i,
  /\btelegram\b.*\breply\b/i,
];

const RISK_PATTERNS = [
  /\bsubmit\b/i,
  /\bsend\b/i,
  /\bdelete\b/i,
  /\bpayment\b/i,
  /\bbuy\b/i,
  /\bpurchase\b/i,
  /\blogin\b/i,
  /\bpassword\b/i,
  /\bcredential\b/i,
  /\bapi\s*key\b/i,
];

export function splitTask(requestText, askdeskOnline = false) {
  const request = normalizeText(requestText);
  if (!request) {
    return {
      request: "",
      askdesk_online: Boolean(askdeskOnline),
      status: "failed",
      hermes_steps: [],
      askdesk_steps: [],
      waiting_for: [],
      done_now_policy: "Empty task cannot be split.",
      next_action: "Ask the user for the task.",
    };
  }

  const hermesSteps = [];
  const askdeskSteps = [];
  for (const clause of clauses(request)) {
    const local = matchesAny(clause, LOCAL_PATTERNS);
    const nonLocal = matchesAny(clause, NON_LOCAL_PATTERNS);
    const risk = matchesAny(clause, RISK_PATTERNS) ? "medium" : "low";
    if (local) {
      askdeskSteps.push({
        owner: "askdesk",
        text: clause,
        reason: "Needs laptop-local file, browser, desktop, account, or installed app access.",
        status: askdeskOnline ? "askdesk_running" : "waiting_for_laptop",
        risk,
      });
    } else {
      hermesSteps.push({
        owner: "hermes",
        text: clause,
        reason: nonLocal
          ? "Can be completed from cloud memory, web/API access, planning, drafting, or scheduling."
          : "No laptop-only signal detected; Hermes should attempt it first and ask AskDesk only if blocked.",
        status: "hermes_running",
        risk,
      });
    }
  }

  const waitingFor = askdeskSteps.length && !askdeskOnline ? ["laptop"] : [];
  let status = "hermes_running";
  let nextAction = "Hermes should complete this without waiting for the laptop.";
  if (hermesSteps.length && askdeskSteps.length) {
    status = askdeskOnline ? "askdesk_needed" : "partial_completed";
    nextAction = askdeskOnline
      ? "Hermes should finish cloud steps and send local steps to AskDesk."
      : "Hermes should finish cloud steps now, then queue local steps as waiting_for_laptop.";
  } else if (askdeskSteps.length) {
    status = askdeskOnline ? "askdesk_needed" : "waiting_for_laptop";
    nextAction = askdeskOnline
      ? "Send the task to AskDesk now."
      : "Queue this task until AskDesk heartbeat says laptop is online.";
  }

  return {
    request,
    askdesk_online: Boolean(askdeskOnline),
    status,
    hermes_steps: hermesSteps,
    askdesk_steps: askdeskSteps,
    waiting_for: waitingFor,
    done_now_policy: "Never wait for the laptop unless a step truly needs local files, browser, desktop, accounts, or installed apps.",
    next_action: nextAction,
  };
}

export function buildTask({ request, split, chatId = "", source = "telegram", cloudSummary = "", attachments = [] }) {
  const now = new Date().toISOString();
  return {
    id: globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID().replaceAll("-", "") : randomId(),
    request,
    source,
    chat_id: String(chatId || ""),
    status: split.status,
    created_at: now,
    updated_at: now,
    hermes_steps: split.hermes_steps,
    askdesk_steps: split.askdesk_steps,
    attachments: Array.isArray(attachments) ? attachments : [],
    waiting_for: split.waiting_for,
    done_now: cloudSummary ? [cloudSummary] : [],
    summary: cloudSummary || defaultCloudSummary(split),
    needs_askdesk: split.askdesk_steps.length > 0,
    next_action: split.next_action,
    result: null,
  };
}

export function formatTelegramReply(task) {
  const lines = [`Task ${task.id.slice(0, 8)}: ${task.status}`];
  if (task.summary && !task.done_now?.includes(task.summary)) lines.push(task.summary);
  if (task.done_now?.length) {
    lines.push("Done now:");
    for (const item of task.done_now.slice(0, 3)) lines.push(`- ${item}`);
  }
  if (task.askdesk_steps?.length) {
    lines.push(task.status === "waiting_for_laptop" || task.status === "partial_completed" ? "Waiting for laptop:" : "AskDesk local steps:");
    for (const step of task.askdesk_steps.slice(0, 4)) lines.push(`- ${step.text}`);
  }
  const nextAction = cleanNextAction(task.next_action);
  if (nextAction) lines.push(`Next: ${nextAction}`);
  return lines.join("\n").slice(0, 3900);
}

export function formatTaskStatus(task) {
  const lines = [`Task ${task.id.slice(0, 8)}: ${task.status}`];
  if (task.request) lines.push(`Request: ${task.request}`);
  if (task.summary && !task.done_now?.includes(task.summary)) lines.push(`Summary: ${task.summary}`);
  if (task.done_now?.length) {
    lines.push("Done:");
    for (const item of task.done_now.slice(0, 4)) lines.push(`- ${item}`);
  }
  if (task.waiting_for?.length) lines.push(`Waiting for: ${task.waiting_for.join(", ")}`);
  if (task.askdesk_steps?.length && !["completed", "failed"].includes(task.status)) {
    lines.push("Laptop/local steps:");
    for (const step of task.askdesk_steps.slice(0, 4)) lines.push(`- ${step.text}`);
  }
  const proof = task.result?.proof || task.result?.task?.proof || [];
  const media = task.result?.telegram_media || {};
  if (Number(media.sent || 0) > 0) {
    lines.push("Proof image was sent directly by AskDesk.");
  } else if (proof.length) {
    lines.push("Proof:");
    for (const item of proof.slice(0, 4)) lines.push(`- ${item.value || item.path || item.type || "proof"}`);
  }
  const nextAction = cleanNextAction(task.next_action);
  if (nextAction) lines.push(`Next: ${nextAction}`);
  if (task.updated_at) lines.push(`Updated: ${task.updated_at}`);
  return lines.join("\n").slice(0, 3900);
}

export function formatRecentTasks(tasks) {
  if (!tasks.length) return "No recent tasks found for this Telegram chat.";
  const lines = ["Recent tasks:"];
  for (const task of tasks.slice(0, 8)) {
    const request = normalizeText(task.request || "").slice(0, 80);
    lines.push(`- ${task.id.slice(0, 8)} | ${task.status} | ${request}`);
  }
  lines.push("Use /task <id> to inspect one task.");
  return lines.join("\n").slice(0, 3900);
}

export function formatSystemStatus({
  mode = "hermes-lite",
  heartbeat = null,
  queueCount = 0,
  modelConfigured = false,
  kvBound = false,
  telegramConfigured = false,
  askdeskTokenConfigured = false,
  mirrorConfigured = false,
  maxHeartbeatAgeSeconds = 120,
} = {}) {
  const askdeskOnline = isAskDeskHeartbeatFresh(heartbeat, maxHeartbeatAgeSeconds);
  const heartbeatAge = heartbeatAgeSeconds(heartbeat);
  const queue = heartbeat?.queue || {};
  const model = heartbeat?.model_status || {};
  const capabilities = Array.isArray(heartbeat?.capability_list) ? heartbeat.capability_list : [];
  const lines = ["Hermes system status"];
  lines.push(`Cloud: online (${mode})`);
  lines.push(`AskDesk laptop: ${askdeskOnline ? "online" : "offline"}`);
  if (heartbeatAge !== null) lines.push(`Last laptop heartbeat: ${heartbeatAge}s ago`);
  lines.push(`Cloud queue: ${Number(queueCount || 0)} waiting`);
  if (heartbeat?.load) lines.push(`AskDesk load: ${heartbeat.load}`);
  if (queue.running_count || queue.pending_count) {
    lines.push(`AskDesk queue: ${Number(queue.running_count || 0)} running, ${Number(queue.pending_count || 0)} pending`);
  }
  lines.push(`Cloud model: ${modelConfigured ? "configured" : "not configured"}`);
  if (model.usable || model.provider || model.model) {
    const modelParts = [model.provider, model.model].filter(Boolean).join(" / ");
    lines.push(`AskDesk model: ${model.usable ? "usable" : "not usable"}${modelParts ? ` (${modelParts})` : ""}`);
  }
  lines.push(`Storage: ${kvBound ? "ready" : "not ready"}`);
  lines.push(`Telegram: ${telegramConfigured ? "configured" : "not configured"}`);
  lines.push(`AskDesk cloud token: ${askdeskTokenConfigured ? "configured" : "not configured"}`);
  lines.push(`Failover mirror: ${mirrorConfigured ? "configured" : "not configured"}`);
  if (capabilities.length) lines.push(`Laptop capabilities: ${capabilities.slice(0, 8).join(", ")}`);
  lines.push(
    askdeskOnline
      ? "Use normal task text. Laptop-local work can run now."
      : "Laptop-local work will queue; cloud-safe work still runs now.",
  );
  return lines.join("\n").slice(0, 3900);
}

export function isAskDeskHeartbeatFresh(heartbeat, maxAgeSeconds = 120) {
  if (!heartbeat || !heartbeat.timestamp) return false;
  const ageMs = Date.now() - Number(heartbeat.timestamp) * 1000;
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= maxAgeSeconds * 1000;
}

function heartbeatAgeSeconds(heartbeat) {
  if (!heartbeat?.timestamp) return null;
  const age = Math.floor(Date.now() / 1000) - Number(heartbeat.timestamp);
  return Number.isFinite(age) && age >= 0 ? age : null;
}

export function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clauses(text) {
  const parts = text
    .split(/\s*(?:,|\band then\b|\bthen\b|\bafter that\b|;)\s*/i)
    .map((part) => part.replace(/[. ]+$/g, "").trim())
    .filter(Boolean);
  if (parts.length <= 1 && /\s+and\s+/i.test(text)) {
    return text
      .split(/\s+\band\s+/i)
      .map((part) => part.replace(/[. ]+$/g, "").trim())
      .filter(Boolean);
  }
  return parts.length ? parts : [text];
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function defaultCloudSummary(split) {
  if (split.hermes_steps.length && split.askdesk_steps.length) {
    return "Hermes-lite captured the cloud/non-local part and queued the laptop-local part.";
  }
  if (split.hermes_steps.length) {
    return "Hermes-lite captured this as cloud-side work.";
  }
  return "Hermes-lite queued this for AskDesk local execution.";
}

function cleanNextAction(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^report result to (telegram|user)$/i.test(text)) return "";
  return text;
}

function randomId() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
