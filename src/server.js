import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import Ajv from "ajv";
import tools from "./tools.json" with { type: "json" };

export const summary = (t, attentionIds = []) => ({
  id: t.id,
  projectId: t.projectId,
  title: t.title,
  modelSelection: t.modelSelection,
  runtimeMode: t.runtimeMode,
  interactionMode: t.interactionMode,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
  settledAt: t.settledAt,
  settledOverride: t.settledOverride,
  session: t.session,
  latestTurn: t.latestTurn,
  latestUserMessageAt: t.latestUserMessageAt,
  hasPendingApprovals: t.hasPendingApprovals,
  hasPendingUserInput: t.hasPendingUserInput,
  ...(t.backgroundLiveness === undefined
    ? {}
    : { backgroundLiveness: t.backgroundLiveness }),
  cursor: JSON.stringify([
    t.latestTurn?.turnId ?? null,
    t.latestTurn?.state ?? null,
    t.session?.status ?? null,
    t.hasPendingApprovals,
    t.hasPendingUserInput,
    t.settledAt,
    t.backgroundLiveness ?? null,
    attentionIds,
  ]),
});
export const ready = (t) =>
  t.hasPendingApprovals ||
  t.hasPendingUserInput ||
  (t.session?.status === "error" &&
    (t.latestUserMessageAt == null ||
      t.session.updatedAt >= t.latestUserMessageAt)) ||
  ((t.latestUserMessageAt == null ||
    [
      t.latestTurn?.requestedAt,
      t.latestTurn?.startedAt,
      t.latestTurn?.completedAt,
    ].some((at) => at != null && at >= t.latestUserMessageAt)) &&
    t.session?.status !== "starting" &&
    t.session?.status !== "running" &&
    t.backgroundLiveness !== "working" &&
    t.latestTurn !== null &&
    t.latestTurn.state !== "running");
const unavailable = () => new Error("Thread is unavailable in this project.");

export function createServer({
  url,
  token,
  sourceThreadId,
  fetch: fetcher = fetch,
  pollIntervalMs = 500,
}) {
  const base = new URL(url);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !["http:", "https:"].includes(base.protocol)
  ) {
    throw new Error(
      "T3_URL must be an HTTP(S) base URL without credentials, query, or fragment.",
    );
  }
  if (
    base.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
  ) {
    throw new Error("Remote T3_URL must use HTTPS.");
  }
  if (!token || !sourceThreadId)
    throw new Error("T3_ACCESS_TOKEN and T3_SOURCE_THREAD_ID are required.");
  const request = async (path, body, signal) => {
    const response = await fetcher(new URL(path, base), {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ?? AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(`T3 request failed (HTTP ${response.status}).`);
    return response.json();
  };
  const shell = () => request("/api/orchestration/shell");
  const load = (snapshot, id) => {
    const t = snapshot.threads.find(
      (t) => t.id === id && t.archivedAt === null,
    );
    if (!t) throw unavailable();
    return t;
  };
  const target = (snapshot, id, caller) => {
    const t = load(snapshot, id);
    if (t.projectId !== caller.projectId) throw unavailable();
    return t;
  };
  const dispatch = async (command) => ({
    threadId: command.threadId,
    ...(await request("/api/orchestration/dispatch", command)),
  });
  const summarize = async (t) => {
    if (!t.hasPendingApprovals && !t.hasPendingUserInput) return summary(t);
    const detail = await request(
      `/api/orchestration/threads/${encodeURIComponent(t.id)}?turnLimit=1`,
    );
    const attentionIds = detail.thread.activities
      .filter(
        (a) =>
          a.kind === "approval.requested" || a.kind === "user-input.requested",
      )
      .map((a) => a.id)
      .sort();
    return summary(t, attentionIds);
  };
  const commandId = (caller, input) =>
    input.commandId === undefined
      ? randomUUID()
      : `mcp:${encodeURIComponent(caller.id)}:${encodeURIComponent(input.commandId)}`;
  const handlers = {
    async create_thread(input, snapshot, caller) {
      const id = commandId(caller, input);
      return dispatch({
        type: "thread.create",
        commandId: id,
        threadId: `mcp-thread:${id}`,
        projectId: caller.projectId,
        title: input.title,
        modelSelection: input.modelSelection ?? caller.modelSelection,
        runtimeMode: caller.runtimeMode,
        interactionMode: caller.interactionMode,
        branch: null,
        worktreePath: null,
        createdAt: new Date().toISOString(),
      });
    },
    async list_threads(input, snapshot, caller) {
      const threads = snapshot.threads
        .filter(
          (t) =>
            t.projectId === caller.projectId &&
            t.archivedAt === null &&
            (input.beforeThreadId === undefined || t.id < input.beforeThreadId),
        )
        .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      const page = threads.slice(0, input.limit ?? 20);
      return {
        threads: await Promise.all(page.map(summarize)),
        nextBeforeThreadId:
          threads.length > page.length ? page.at(-1).id : null,
      };
    },
    async read_thread(input, snapshot, caller) {
      let previousThreadSequence;
      for (let attempt = 0; attempt < 3; attempt++) {
        const thread = target(snapshot, input.threadId, caller);
        const query = new URLSearchParams({ turnLimit: String(input.turnLimit ?? 10) });
        if (input.beforeCursor !== undefined) query.set("beforeCursor", input.beforeCursor);
        const detail = await request(
          `/api/orchestration/threads/${encodeURIComponent(thread.id)}?${query}`,
        );
        const threadSequence = detail.page?.threadSequence;
        // Two equal per-thread watermarks bracket the shell read even when other
        // projects keep advancing the environment-wide projection sequence.
        const stableThread = threadSequence !== undefined && threadSequence === previousThreadSequence;
        if (snapshot.snapshotSequence !== detail.snapshotSequence && !stableThread) {
          previousThreadSequence = threadSequence;
          if (attempt < 2) snapshot = await shell();
          continue;
        }
        return {
          thread: summary(
            thread,
            detail.thread.activities
              .filter((a) => a.kind === "approval.requested" || a.kind === "user-input.requested")
              .map((a) => a.id)
              .sort(),
          ),
          snapshotSequence: detail.snapshotSequence,
          ...(detail.page === undefined ? {} : { page: detail.page }),
          messages: detail.thread.messages.map((m) => ({
            id: m.id,
            role: m.role,
            text: m.text.slice(0, 8000),
            truncated: m.text.length > 8000,
            createdAt: m.createdAt,
          })),
        };
      }
      throw new Error("Thread operation failed.");
    },
    async send_message_to_thread(input, snapshot, caller) {
      const t = target(snapshot, input.threadId, caller);
      const id = commandId(caller, input);
      return dispatch({
        type: "thread.turn.start",
        commandId: id,
        threadId: t.id,
        message: {
          messageId: `mcp-message:${id}`,
          role: "user",
          attachments: [],
          text: `Message from T3 thread ${caller.id}.${input.replyToSource === false ? "" : " Reply with send_message_to_thread using that thread ID."}\n\n${input.message}`,
        },
        ...(input.modelSelection === undefined
          ? {}
          : { modelSelection: input.modelSelection }),
        runtimeMode: t.runtimeMode,
        interactionMode: t.interactionMode,
        createdAt: new Date().toISOString(),
      });
    },
    async wait_threads(input, snapshot, caller, signal) {
      const deadline = Date.now() + (input.timeoutSeconds ?? 60) * 1000;
      for (;;) {
        const threads = await Promise.all(
          input.targets.map((entry) =>
            summarize(target(snapshot, entry.threadId, caller)),
          ),
        );
        if (
          threads.some(
            (t, i) => ready(t) && t.cursor !== input.targets[i].cursor,
          )
        )
          return { threads, timedOut: false };
        if (Date.now() >= deadline) return { threads, timedOut: true };
        await delay(
          Math.min(pollIntervalMs, deadline - Date.now()),
          undefined,
          { signal },
        );
        snapshot = await shell();
        caller = load(snapshot, sourceThreadId);
      }
    },
    async set_thread_settled(input, snapshot, caller) {
      const t = target(snapshot, input.threadId, caller);
      return dispatch({
        type: input.settled ? "thread.settle" : "thread.unsettle",
        commandId: commandId(caller, input),
        threadId: t.id,
        ...(input.settled ? {} : { reason: "user" }),
      });
    },
    async interrupt_thread(input, snapshot, caller) {
      const t = target(snapshot, input.threadId, caller);
      return dispatch({
        type: "thread.turn.interrupt",
        commandId: commandId(caller, input),
        threadId: t.id,
        createdAt: new Date().toISOString(),
      });
    },
  };
  const ajv = new Ajv({ strict: false, validateFormats: false });
  const validators = new Map(
    tools.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]),
  );
  const server = new Server(
    { name: "t3code-thread-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const input = req.params.arguments ?? {};
    const validate = validators.get(req.params.name);
    if (!validate || !validate(input))
      throw new McpError(ErrorCode.InvalidParams, "Invalid tool arguments.");
    try {
      const snapshot = await shell();
      const result = await handlers[req.params.name](
        input,
        snapshot,
        load(snapshot, sourceThreadId),
        extra.signal,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      // Never echo HTTP bodies, URLs, bearer credentials or provider output in errors.
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              error.message === unavailable().message
                ? error.message
                : "Thread operation failed.",
          },
        ],
      };
    }
  });
  return server;
}
