import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import tools from "../src/tools.json" with { type: "json" };

const stamp = "2026-09-11T00:00:00.000Z";
const thread = (id, projectId = "project") => ({
  id,
  projectId,
  title: id,
  modelSelection: {
    instanceId: "codex",
    model: "gpt-6-astra",
    options: [{ id: "reasoningEffort", value: "low" }],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: stamp,
  updatedAt: stamp,
  archivedAt: null,
  latestUserMessageAt: null,
  settledAt: null,
  settledOverride: null,
  session: null,
  latestTurn: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  backgroundLiveness: null,
});
async function fixture(run, sourceId = "source", beforeDetail = () => {}) {
  const threads = [
    thread(sourceId),
    thread("worker"),
    thread("foreign", "other"),
  ];
  let snapshotSequence = 10;
  let threadSequence = 1;
  const requests = [];
  const messages = [];
  const receipts = new Map();
  const http = httpServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture-token");
    let body;
    if (req.method === "POST")
      body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString());
    requests.push({ url: req.url, body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/orchestration/shell")
      return res.end(JSON.stringify({ snapshotSequence, threads }));
    if (req.url.startsWith("/api/orchestration/threads/")) {
      const beforeThread = JSON.stringify(threads[1]);
      if (beforeDetail(threads)) snapshotSequence++;
      if (JSON.stringify(threads[1]) !== beforeThread) threadSequence++;
      return res.end(
        JSON.stringify({
          snapshotSequence,
          thread: {
            ...threads[1],
            messages,
            activities: threads[1].activities ?? [],
          },
          page: { beforeCursor: null, hasMore: false, snapshotSequence, threadSequence },
        }),
      );
    }
    if (req.url === "/api/orchestration/dispatch") {
      if (!receipts.has(body.commandId)) {
        receipts.set(body.commandId, { sequence: receipts.size + 1 });
        if (body.type === "thread.create")
          threads.push({
            ...thread(body.threadId),
            title: body.title,
            modelSelection: body.modelSelection,
          });
        if (body.type === "thread.turn.start")
          messages.push({
            id: body.message.messageId,
            role: "user",
            text: body.message.text,
            createdAt: body.createdAt,
          });
      }
      return res.end(JSON.stringify(receipts.get(body.commandId)));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const client = new Client({ name: "stdio-consumer", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.js"],
      env: {
        ...process.env,
        T3_URL: `http://127.0.0.1:${http.address().port}`,
        T3_ACCESS_TOKEN: "fixture-token",
        T3_SOURCE_THREAD_ID: sourceId,
      },
    }),
  );
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return r.isError
      ? r
      : (r.structuredContent ?? JSON.parse(r.content[0].text));
  };
  try {
    await run({ client, call, threads, messages, requests });
  } finally {
    await client.close();
    await new Promise((resolve) => http.close(resolve));
  }
}

test("stdio advertises native schemas and scopes discovery and every target operation", () =>
  fixture(async ({ client, call, requests }) => {
    assert.deepEqual((await client.listTools()).tools, tools);
    assert.deepEqual(
      (await call("list_threads")).threads.map((t) => t.id),
      ["worker", "source"],
    );
    for (const [name, args] of [
      ["read_thread", { threadId: "foreign" }],
      ["send_message_to_thread", { threadId: "foreign", message: "no" }],
      ["set_thread_settled", { threadId: "foreign", settled: true }],
      ["interrupt_thread", { threadId: "foreign" }],
      [
        "wait_threads",
        { targets: [{ threadId: "foreign" }], timeoutSeconds: 0 },
      ],
    ])
      assert.equal((await call(name, args)).isError, true, name);
    assert(!requests.some((r) => r.body));
  }));

test("mutation retries retain IDs and optional reply instruction is honored", () =>
  fixture(async ({ call, requests, messages }) => {
    const args = { title: "worker", commandId: "create-1" };
    const created = await call("create_thread", args);
    assert.equal(created.threadId, "mcp-thread:mcp:source:create-1");
    assert.deepEqual(await call("create_thread", args), created);
    const input = {
      threadId: "worker",
      message: "Do work",
      commandId: "send-1",
      replyToSource: false,
    };
    const sent = await call("send_message_to_thread", input);
    assert.deepEqual(await call("send_message_to_thread", input), sent);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, "Message from T3 thread source.\n\nDo work");
    assert.equal(messages[0].id, "mcp-message:mcp:source:send-1");
    const commands = requests.filter((r) => r.body).map((r) => r.body);
    assert.equal(commands[0].worktreePath, null);
    assert.equal(commands[2].modelSelection, undefined);
    await assert.rejects(() =>
      call("create_thread", { title: "nullable A", commandId: null }),
    );
    await assert.rejects(() => call("list_threads", { beforeThreadId: null }));
  }));

test("wait cursor ignores commentary and wakes for terminal state or attention", () =>
  fixture(async ({ call, threads }) => {
    const t = threads[1];
    assert.equal(
      (
        await call("wait_threads", {
          targets: [{ threadId: "worker" }],
          timeoutSeconds: 0,
        })
      ).timedOut,
      true,
    );
    t.latestTurn = {
      turnId: "turn-1",
      state: "completed",
      requestedAt: stamp,
      completedAt: stamp,
    };
    t.session = { status: "ready" };
    const completed = await call("wait_threads", {
      targets: [{ threadId: "worker" }],
      timeoutSeconds: 0,
    });
    assert.equal(completed.timedOut, false);
    t.updatedAt = "2026-09-11T01:00:00.000Z";
    const targets = [
      { threadId: "worker", cursor: completed.threads[0].cursor },
    ];
    assert.equal(
      (await call("wait_threads", { targets, timeoutSeconds: 0 })).timedOut,
      true,
    );
    t.latestUserMessageAt = "2026-09-11T01:00:00.000Z";
    assert.equal(
      (
        await call("wait_threads", {
          targets: [{ threadId: "worker" }],
          timeoutSeconds: 0,
        })
      ).timedOut,
      true,
    );
    t.latestUserMessageAt = null;
    t.hasPendingApprovals = true;
    t.activities = [{ id: "request-a", kind: "approval.requested" }];
    const firstApproval = await call("wait_threads", {
      targets,
      timeoutSeconds: 0,
    });
    assert.equal(firstApproval.timedOut, false);
    t.activities = [{ id: "request-b", kind: "approval.requested" }];
    assert.equal(
      (
        await call("wait_threads", {
          targets: [
            { threadId: "worker", cursor: firstApproval.threads[0].cursor },
          ],
          timeoutSeconds: 0,
        })
      ).timedOut,
      false,
    );
  }));

test("bounds reads and rejects malformed inputs before HTTP dispatch", () =>
  fixture(async ({ call, messages, requests }) => {
    messages.push({
      id: "large",
      role: "assistant",
      text: "x".repeat(9000),
      createdAt: stamp,
    });
    const read = await call("read_thread", {
      threadId: "worker",
      turnLimit: 2,
      beforeCursor: "older",
    });
    assert.equal(read.messages[0].text.length, 8000);
    assert.equal(read.messages[0].truncated, true);
    assert(
      requests.some((r) => r.url.endsWith("?turnLimit=2&beforeCursor=older")),
    );
    await assert.rejects(() =>
      call("wait_threads", { targets: [], timeoutSeconds: 0 }),
    );
    await assert.rejects(() =>
      call("read_thread", { threadId: "worker", turnLimit: 101 }),
    );
    await assert.rejects(() =>
      call("set_thread_settled", { threadId: "worker", settled: "yes" }),
    );
  }));


test("retry IDs cannot collide across caller and retry delimiters", async () => {
  const ids = [];
  for (const [sourceId, commandId] of [["source", "b:c"], ["source:b", "c"], ["source", "b%3Ac"]]) {
    await fixture(async ({ call, threads }) => {
      const args = { title: "Unique worker", commandId };
      const created = await call("create_thread", args);
      assert.deepEqual(await call("create_thread", args), created);
      assert.equal(threads.filter(t => t.id === created.threadId).length, 1);
      ids.push(created.threadId);
    }, sourceId);
  }
  assert.equal(new Set(ids).size, 3);
});

test("read retries mismatched snapshot sequences and bounds unstable reads", async () => {
  let changed = false;
  await fixture(
    async ({ call, requests }) => {
      const read = await call("read_thread", { threadId: "worker" });
      assert.equal(read.thread.title, "New title");
      assert.equal(read.snapshotSequence, 11);
      assert.equal(
        requests.filter((r) => r.url.startsWith("/api/orchestration/threads/")).length,
        2,
      );
    },
    "source",
    (threads) => {
      if (changed) return false;
      changed = true;
      threads[1].title = "New title";
      return true;
    },
  );
  await fixture(
    async ({ call, requests }) => {
      assert.equal((await call("read_thread", { threadId: "worker" })).isError, true);
      assert.equal(
        requests.filter((r) => r.url.startsWith("/api/orchestration/threads/")).length,
        3,
      );
    },
    "source",
    threads => { threads[1].title += " changed"; return true; },
  );
});


test("unrelated projection updates do not exhaust thread reads", () =>
  fixture(async ({ call, requests }) => {
    const read = await call("read_thread", { threadId: "worker" });
    assert.equal(read.thread.id, "worker");
    assert.equal(read.snapshotSequence, 12);
    assert.equal(requests.filter(r => r.url.startsWith("/api/orchestration/threads/")).length, 2);
  }, "source", () => true));
