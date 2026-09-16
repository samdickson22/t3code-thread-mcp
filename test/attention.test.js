import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGlobalServer } from "../src/global-server.js";

test("archived attention never requests active-only detail and older request payload survives read limits", async () => {
  const original = globalThis.WebSocket;
  const active = {
    id: "a",
    projectId: "p",
    archivedAt: null,
    latestTurn: null,
    hasPendingApprovals: true,
    hasPendingUserInput: false,
  };
  const archived = { ...active, id: "z", archivedAt: "2026-09-16T00:00:00Z" };
  const calls = [];
  globalThis.WebSocket = class {
    constructor() {
      queueMicrotask(() => this.onopen?.());
    }
    send(raw) {
      const m = JSON.parse(raw);
      if (m._tag !== "Request") return;
      queueMicrotask(() =>
        this.onmessage({
          data: JSON.stringify({
            _tag: "Exit",
            requestId: "0",
            exit: { _tag: "Success", value: { threads: [archived] } },
          }),
        }),
      );
    }
    close() {}
  };
  const activities = [
    {
      id: "old",
      kind: "approval.requested",
      payload: { requestId: "approval-1" },
    },
    ...Array.from({ length: 60 }, (_, i) => ({ id: String(i), kind: "other" })),
  ];
  const fetcher = async (url) => {
    const p = new URL(url).pathname;
    calls.push(p);
    const data =
      p === "/api/orchestration/shell"
        ? { snapshotSequence: 1, projects: [{ id: "p" }], threads: [active] }
        : p === "/api/auth/websocket-ticket"
          ? { ticket: "test" }
          : p === "/api/orchestration/threads/a"
            ? {
                snapshotSequence: 1,
                thread: { messages: [], activities },
                page: { threadSequence: 1 },
              }
            : null;
    assert.notEqual(data, null, `Unexpected request ${p}`);
    return { ok: true, json: async () => data };
  };
  const server = createGlobalServer({
    environments: [{ id: "e", url: "http://localhost", token: "test" }],
    defaultEnvironment: "e",
    fetch: fetcher,
  });
  const client = new Client({ name: "attention-regression", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st);
    await client.connect(ct);
    let r = await client.callTool({
      name: "list_archived_threads",
      arguments: {},
    });
    assert.equal(r.isError, undefined);
    assert.equal(r.structuredContent.threads[0].id, "z");
    assert(!calls.some((p) => p.startsWith("/api/orchestration/threads/")));
    r = await client.callTool({
      name: "read_thread",
      arguments: { threadId: "z" },
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /does not expose archived history/);
    r = await client.callTool({
      name: "read_thread",
      arguments: { threadId: "a" },
    });
    assert.equal(r.structuredContent.activities.length, 51);
    assert.equal(
      r.structuredContent.activities[0].payload.requestId,
      "approval-1",
    );
  } finally {
    await client.close();
    await server.close();
    globalThis.WebSocket = original;
  }
});
