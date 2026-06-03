import assert from "node:assert/strict";
import test from "node:test";

import { createApp, MemoryStore } from "../main.js";

function testRuntime() {
  const store = new MemoryStore();
  const telegramCalls = [];
  const app = createApp({
    store,
    env: {
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_ALLOWED_CHAT_IDS: "123",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      ASKDESK_TOKEN: "ask-token",
      ADMIN_TOKEN: "admin-token",
    },
    fetchImpl: async (url, options = {}) => {
      telegramCalls.push({ url: String(url), body: JSON.parse(options.body || "{}") });
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    },
  });
  return { app, store, telegramCalls };
}

test("deno app health reports deno mode", async () => {
  const { app } = testRuntime();

  const response = await app(new Request("https://deno.test/health"));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "deno-deploy");
  assert.equal(payload.telegram_configured, true);
});

test("telegram pdf task queues for AskDesk and result sends polished answer only", async () => {
  const { app, telegramCalls } = testRuntime();

  await app(
    new Request("https://deno.test/askdesk/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer ask-token" },
      body: JSON.stringify({ online: true }),
    }),
  );

  const webhook = await app(
    new Request("https://deno.test/telegram/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "webhook-secret" },
      body: JSON.stringify({
        message: {
          chat: { id: 123 },
          caption: "read this pdf",
          document: {
            file_id: "file-1",
            file_unique_id: "unique-1",
            file_name: "notes.pdf",
            mime_type: "application/pdf",
            file_size: 1234,
          },
        },
      }),
    }),
  );
  const webhookPayload = await webhook.json();
  assert.equal(webhookPayload.status, "askdesk_needed");
  assert.equal(telegramCalls.filter((call) => call.url.includes("/sendMessage")).length, 0);
  assert.equal(telegramCalls.filter((call) => call.url.includes("/sendChatAction")).length, 1);

  const tasksResponse = await app(
    new Request("https://deno.test/askdesk/tasks?limit=1", {
      headers: { Authorization: "Bearer ask-token" },
    }),
  );
  const tasksPayload = await tasksResponse.json();
  assert.equal(tasksPayload.tasks.length, 1);
  assert.equal(tasksPayload.tasks[0].attachments[0].file_name, "notes.pdf");

  const taskId = tasksPayload.tasks[0].task_id;
  const resultResponse = await app(
    new Request(`https://deno.test/askdesk/tasks/${taskId}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer ask-token" },
      body: JSON.stringify({
        ok: true,
        status: "completed",
        summary: "Document Brief\n\nMain read:\n- Git notes checked.",
        next_action: "",
      }),
    }),
  );
  const resultPayload = await resultResponse.json();
  assert.equal(resultPayload.task.status, "completed");

  const sentMessages = telegramCalls.filter((call) => call.url.includes("/sendMessage"));
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].body.text, /^Document Brief/);
  assert.doesNotMatch(sentMessages[0].body.text, /Done [a-f0-9]{8}/);
  assert.doesNotMatch(sentMessages[0].body.text, /AskDesk result/i);
});

test("admin task can be claimed through AskDesk queue", async () => {
  const { app } = testRuntime();

  const createResponse = await app(
    new Request("https://deno.test/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer admin-token" },
      body: JSON.stringify({ request: "take screenshot of my screen", chat_id: "123" }),
    }),
  );
  const createPayload = await createResponse.json();
  assert.equal(createPayload.task.needs_askdesk, true);

  const tasksResponse = await app(
    new Request("https://deno.test/askdesk/tasks", {
      headers: { Authorization: "Bearer ask-token" },
    }),
  );
  const tasksPayload = await tasksResponse.json();
  assert.equal(tasksPayload.tasks.length, 1);
  assert.equal(tasksPayload.tasks[0].request, "take screenshot of my screen");
});
