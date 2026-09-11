import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
test(
  "real requested models exchange, settle, revive and report unsupported driver switching",
  { skip: !process.env.T3_LIVE_TEST_URL, timeout: 240000 },
  async () => {
    const runId = randomUUID();
    const clients = [];
    async function peer(source) {
      const client = new Client({
        name: "external-peer-validation",
        version: "1",
      });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ["src/cli.js"],
          env: {
            ...process.env,
            T3_URL: process.env.T3_LIVE_TEST_URL,
            T3_ACCESS_TOKEN: process.env.T3_ACCESS_TOKEN,
            T3_SOURCE_THREAD_ID: source,
          },
        }),
      );
      clients.push(client);
      return async (name, args) => {
        const raw = await client.callTool(
          { name, arguments: args },
          undefined,
          { timeout: 75000 },
        );
        assert(!raw.isError, JSON.stringify(raw));
        return raw.structuredContent ?? JSON.parse(raw.content[0].text);
      };
    }
    const codex = {
      instanceId: "codex",
      model: "gpt-6-astra",
      options: [{ id: "reasoningEffort", value: "low" }],
    };
    const claude = {
      instanceId: "claudeAgent",
      model: "claude-fable-5.1",
      options: [{ id: "effort", value: "low" }],
    };
    try {
      const control = await peer(process.env.T3_SOURCE_THREAD_ID);
      const a = await control("create_thread", {
        title: "External GPT-6 Astra peer",
        modelSelection: codex,
        commandId: runId + "-codex",
      });
      const b = await control("create_thread", {
        title: "External Claude Fable 5.1 peer",
        modelSelection: claude,
        commandId: runId + "-claude",
      });
      const fromA = await peer(a.threadId),
        fromB = await peer(b.threadId);
      await fromA("send_message_to_thread", {
        threadId: b.threadId,
        replyToSource: false,
        commandId: "codex-to-claude",
        message:
          "Remember violet-moon-416. Reply exactly CLAUDE_RECEIVED violet-moon-416. Do not use tools.",
      });
      let waitB = await fromA("wait_threads", {
        targets: [{ threadId: b.threadId }],
        timeoutSeconds: 60,
      });
      let readB = await fromA("read_thread", { threadId: b.threadId });
      assert.equal(readB.thread.session.providerName, "claudeAgent");
      const replyB =
        readB.messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
      assert(
        replyB.includes("CLAUDE_RECEIVED violet-moon-416"),
        JSON.stringify(readB.thread.session),
      );
      await fromB("send_message_to_thread", {
        threadId: a.threadId,
        replyToSource: false,
        commandId: "claude-to-codex",
        message: `${replyB}\nReply exactly CODEX_RECEIVED violet-moon-416. Do not use tools.`,
      });
      let waitA = await fromB("wait_threads", {
        targets: [{ threadId: a.threadId }],
        timeoutSeconds: 60,
      });
      let readA = await fromB("read_thread", { threadId: a.threadId });
      assert(
        readA.messages.some(
          (m) =>
            m.role === "assistant" &&
            m.text.includes("CODEX_RECEIVED violet-moon-416"),
        ),
      );
      assert.equal(readA.thread.session.providerName, "codex");
      for (const [call, id] of [
        [fromA, b.threadId],
        [fromB, a.threadId],
      ])
        await call("set_thread_settled", { threadId: id, settled: true });
      await fromA("send_message_to_thread", {
        threadId: b.threadId,
        replyToSource: false,
        commandId: "revive-claude",
        message:
          "What marker did the other thread send? Reply only that marker. Do not use tools.",
      });
      await fromA("wait_threads", {
        targets: [{ threadId: b.threadId, cursor: waitB.threads[0].cursor }],
        timeoutSeconds: 60,
      });
      readB = await fromA("read_thread", { threadId: b.threadId });
      assert(
        readB.messages
          .filter((m) => m.role === "assistant")
          .at(-1)
          .text.includes("violet-moon-416"),
      );
      assert.notEqual(readB.thread.settledOverride, "settled");
      await fromB("send_message_to_thread", {
        threadId: a.threadId,
        replyToSource: false,
        commandId: "revive-codex",
        message:
          "What marker did the other thread send? Reply only that marker. Do not use tools.",
      });
      await fromB("wait_threads", {
        targets: [{ threadId: a.threadId, cursor: waitA.threads[0].cursor }],
        timeoutSeconds: 60,
      });
      readA = await fromB("read_thread", { threadId: a.threadId });
      assert(
        readA.messages
          .filter((m) => m.role === "assistant")
          .at(-1)
          .text.includes("violet-moon-416"),
      );
      assert.notEqual(readA.thread.settledOverride, "settled");
      await fromB("send_message_to_thread", {
        threadId: a.threadId,
        replyToSource: false,
        commandId: "switch-provider",
        modelSelection: claude,
        message: "Reply exactly SWITCHED_TO_CLAUDE. Do not use tools.",
      });
      await fromB("wait_threads", {
        targets: [{ threadId: a.threadId, cursor: readA.thread.cursor }],
        timeoutSeconds: 60,
      });
      const switched = await fromB("read_thread", { threadId: a.threadId });
      assert.equal(switched.thread.modelSelection.instanceId, "codex");
      assert.equal(switched.thread.session.status, "error");
      assert(switched.thread.session.lastError.includes("cannot switch"));
      assert(
        switched.messages.some(
          (m) => m.role === "assistant" && m.text.includes("CODEX_RECEIVED"),
        ),
      );
      console.log(
        JSON.stringify({
          passed: true,
          route: "released 0.0.40 external stdio MCP",
          codexThread: a.threadId,
          claudeThread: b.threadId,
          checks: [
            "Codex to Claude attributed send",
            "Claude real Fable reply",
            "Claude to Codex attributed send",
            "Codex real Astra low reply",
            "both settle and revive with remembered history",
          ],
        }),
      );
    } finally {
      for (const c of clients) await c.close();
    }
  },
);
