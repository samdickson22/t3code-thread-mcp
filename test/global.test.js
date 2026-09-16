import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const stamp = "2026-09-16T00:00:00.000Z";
const thread = (id, projectId) => ({
  id,
  projectId,
  title: id,
  archivedAt: null,
  modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  latestTurn: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  settledAt: null,
});
async function fixture(run, { single = false } = {}) {
  const servers = [];
  const envs = [];
  const states = [];
  const clients = [];
  const dir = await mkdtemp(join(tmpdir(), "global-mcp-"));
  try {
    for (const id of ["a", "b"]) {
      const state = {
        id,
        projects: [
          { id: "p1", workspaceRoot: "/workspace/one" },
          { id: "p2", workspaceRoot: "/workspace/two" },
        ],
        threads: [thread("same-id", "p1"), thread("other-project", "p2")],
        commands: [],
        messages: [],
        receipts: new Map(),
      };
      states.push(state);
      const server = createServer(async (req, res) => {
        assert.equal(req.headers.authorization, `Bearer token-${id}`);
        res.setHeader("content-type", "application/json");
        if (req.url === "/api/orchestration/shell" && state.hangShell) return;
        if (req.url === "/api/orchestration/shell")
          return res.end(
            JSON.stringify({
              snapshotSequence: 1,
              projects: state.projects,
              threads: state.threads,
            }),
          );
        if (
          req.url.startsWith("/api/orchestration/threads/") &&
          state.detailDelay
        )
          await new Promise((r) => setTimeout(r, state.detailDelay));
        if (req.url.startsWith("/api/orchestration/threads/"))
          return res.end(
            JSON.stringify({
              snapshotSequence: 1,
              page: { threadSequence: 1 },
              thread: { messages: state.messages, activities: [] },
            }),
          );
        if (req.url === "/api/orchestration/dispatch") {
          const c = JSON.parse(
            Buffer.concat(await Array.fromAsync(req)).toString(),
          );
          state.commands.push(c);
          if (!state.receipts.has(c.commandId)) {
            state.receipts.set(c.commandId, {
              sequence: state.receipts.size + 1,
            });
            if (c.type === "thread.create")
              state.threads.push({ ...thread(c.threadId, c.projectId), ...c });
            if (c.type === "thread.turn.start")
              state.messages.push({
                id: c.message.messageId,
                role: "user",
                text: c.message.text,
                createdAt: stamp,
              });
          }
          return res.end(JSON.stringify(state.receipts.get(c.commandId)));
        }
        res.statusCode = 404;
        res.end("{}");
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      servers.push(server);
      envs.push({
        id,
        url: `http://127.0.0.1:${server.address().port}`,
        tokenEnv: `TOKEN_${id}`,
      });
    }
    const config = join(dir, "config.json");
    await writeFile(config, JSON.stringify({ environments: envs }));
    const connect = async () => {
      const env = { ...process.env, TOKEN_a: "token-a", TOKEN_b: "token-b" };
      delete env.T3_SOURCE_THREAD_ID;
      delete env.T3_MCP_CONFIG;
      delete env.T3_URL;
      if (single)
        Object.assign(env, { T3_URL: envs[0].url, T3_ACCESS_TOKEN: "token-a" });
      const c = new Client({ name: "global-stdio-test", version: "1" });
      await c.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ["src/cli.js", ...(single ? [] : ["--config", config])],
          env,
        }),
      );
      clients.push(c);
      return c;
    };
    const client = await connect();
    const call = async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return r.isError ? r : r.structuredContent;
    };
    await run({ client, call, states, connect });
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await Promise.all(
      servers.map(
        (s) =>
          new Promise((r) => {
            s.closeAllConnections();
            s.close(r);
          }),
      ),
    );
    await rm(dir, { recursive: true });
  }
}
test("global stdio starts with no source and accesses another project", () =>
  fixture(
    async ({ call }) => {
      assert.equal(
        (await call("list_environments")).environments[0].id,
        "default",
      );
      const t = await call("create_thread", {
        projectId: "p2",
        title: "No parent",
        modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
      });
      assert(t.threadId);
      assert.equal(
        (await call("read_thread", { threadId: "other-project" })).thread
          .projectId,
        "p2",
      );
    },
    { single: true },
  ));
test("global stdio routes independent servers, honest messages, retries and cross-environment waits", () =>
  fixture(async ({ client, call, states, connect }) => {
    assert.equal((await client.listTools()).tools.length, 21);
    assert.equal((await call("list_projects")).isError, true);
    assert.equal(
      (await call("list_projects", { environmentId: "unknown" })).isError,
      true,
    );
    for (const environmentId of ["a", "b"])
      assert.equal(
        (await call("list_projects", { environmentId })).projects.length,
        2,
      );
    const input = {
      environmentId: "b",
      projectId: "p2",
      title: "Cross-project worker",
      modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5-1" },
      commandId: "same:key",
    };
    const created = await call("create_thread", input);
    assert.equal(created.environmentId, "b");
    assert.equal(states[0].commands.length, 0);
    assert.equal(states[1].commands[0].projectId, "p2");
    assert.equal(states[1].commands[0].runtimeMode, "approval-required");
    const second = await connect();
    assert.deepEqual(
      (await second.callTool({ name: "create_thread", arguments: input }))
        .structuredContent,
      created,
    );
    const elsewhere = await call("create_thread", {
      ...input,
      environmentId: "a",
    });
    assert.notEqual(created.threadId, elsewhere.threadId);
    await call("send_message_to_thread", {
      environmentId: "b",
      threadId: created.threadId,
      message: "plain message",
    });
    assert.equal(states[1].messages[0].text, "plain message");
    await call("send_message_to_thread", {
      environmentId: "b",
      threadId: created.threadId,
      message: "reply please",
      source: { environmentId: "a", threadId: "same-id" },
    });
    assert.match(
      states[1].messages[1].text,
      /environmentId "a" and threadId "same-id"/,
    );
    const before = states[1].commands.length;
    assert.equal(
      (
        await call("send_message_to_thread", {
          environmentId: "b",
          threadId: created.threadId,
          message: "bad source",
          source: { environmentId: "nope", threadId: "same-id" },
        })
      ).isError,
      true,
    );
    assert.equal(states[1].commands.length, before);
    states[0].threads[0].latestTurn = {
      turnId: "turn-a",
      state: "completed",
      completedAt: stamp,
    };
    states[0].threads[0].session = { status: "ready" };
    const result = await call("wait_threads", {
      targets: [
        { environmentId: "a", threadId: "same-id" },
        { environmentId: "b", threadId: "same-id" },
      ],
      timeoutSeconds: 0,
    });
    assert.equal(result.timedOut, false);
    assert(result.threads.some((t) => t.environmentId === "a"));
    assert.deepEqual(
      [...result.threads, ...result.unavailable]
        .map((t) => t.environmentId)
        .sort(),
      ["a", "b"],
    );
    states[1].hangShell = true;
    const started = Date.now();
    const partial = await call("wait_threads", {
      targets: [
        { environmentId: "a", threadId: "same-id" },
        { environmentId: "b", threadId: "same-id" },
      ],
      timeoutSeconds: 60,
    });
    assert.equal(partial.timedOut, false);
    assert(partial.threads.some((t) => t.environmentId === "a"));
    assert(partial.unavailable.some((t) => t.environmentId === "b"));
    assert(Date.now() - started < 5000);
    states[1].hangShell = false;
    states[0].threads[1].hasPendingApprovals = true;
    states[0].detailDelay = 40;
    const siblings = await call("wait_threads", {
      targets: [
        { environmentId: "a", threadId: "missing" },
        { environmentId: "a", threadId: "other-project" },
      ],
      timeoutSeconds: 1,
    });
    assert(siblings.threads.some((t) => t.id === "other-project"));
    assert(siblings.unavailable.some((t) => t.threadId === "missing"));
    states[0].detailDelay = 0;
    states[1].hangShell = true;
    const timeoutStarted = Date.now();
    const timed = await call("wait_threads", {
      targets: [{ environmentId: "b", threadId: "same-id" }],
      timeoutSeconds: 0,
    });
    assert.equal(timed.timedOut, true);
    assert.equal(timed.unavailable[0].reason, "timeout");
    assert(Date.now() - timeoutStarted < 3000);
    states[1].hangShell = false;
    await assert.rejects(() =>
      call("create_thread", { environmentId: "a", title: "missing project" }),
    );
    for (const [name, args, type] of [
      ["set_thread_title", { title: "renamed" }, "thread.meta.update"],
      ["set_thread_pinned", { pinned: true }, "thread.pin"],
      ["set_thread_archived", { archived: true }, "thread.archive"],
      ["set_thread_archived", { archived: false }, "thread.unarchive"],
      [
        "respond_to_approval",
        { requestId: "r", decision: "acceptAlways" },
        "thread.approval.respond",
      ],
      [
        "respond_to_user_input",
        { requestId: "r", answers: { question: { answers: ["yes"] } } },
        "thread.user-input.respond",
      ],
      ["set_thread_snoozed", { snoozedUntil: null }, "thread.unsnooze"],
      ["delete_thread", {}, "thread.delete"],
    ]) {
      const r = await call(name, {
        environmentId: "b",
        threadId: "other-project",
        ...args,
      });
      assert.equal(r.isError, undefined, name);
      assert.equal(states[1].commands.at(-1).type, type);
    }
  }));
