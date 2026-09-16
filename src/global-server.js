import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import Ajv from "ajv";
import { summary, ready } from "./server.js";
import { globalTools } from "./global-tools.js";
import { rpc } from "./rpc.js";
import { desktopUnavailable } from "./desktop.js";

export function createGlobalServer({
  environments = [],
  desktop,
  defaultEnvironment,
  fetch: fetcher = fetch,
  pollIntervalMs = 500,
}) {
  const clients = new Map();
  for (const env of environments) {
    const base = new URL(env.url);
    if (
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      !["http:", "https:"].includes(base.protocol) ||
      (base.protocol === "http:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
    )
      throw new Error(
        "Environment URLs must use HTTPS or loopback HTTP without credentials, query or fragment.",
      );
    if (!env.token || !env.id || clients.has(env.id))
      throw new Error("Each environment needs a unique ID and access token.");
    const request = async (path, body, signal) => {
      const timeout = AbortSignal.timeout(30000);
      const response = await fetcher(new URL(path, base), {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${env.token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) throw new Error("T3 request failed.");
      return response.json();
    };
    clients.set(env.id, {
      id: env.id,
      label: env.label ?? env.id,
      request,
      rpc: (method, signal) => rpc(base, request, method, signal),
      shell: (signal) => request("/api/orchestration/shell", undefined, signal),
    });
  }
  const find = (snapshot, id) => {
    const thread = snapshot.threads.find((t) => t.id === id);
    if (!thread) throw new Error("Thread is unavailable.");
    return thread;
  };
  const detailed = async (client, threadId, input, signal) => {
    const query = new URLSearchParams({
      turnLimit: String(input.turnLimit ?? 10),
    });
    if (input.beforeCursor !== undefined)
      query.set("beforeCursor", input.beforeCursor);
    return client.request(
      `/api/orchestration/threads/${encodeURIComponent(threadId)}?${query}`,
      undefined,
      signal,
    );
  };
  const summarize = async (client, t, signal) => {
    const ids =
      t.archivedAt == null && (t.hasPendingApprovals || t.hasPendingUserInput)
        ? (
            await detailed(client, t.id, { turnLimit: 1 }, signal)
          ).thread.activities
            .filter((a) =>
              ["approval.requested", "user-input.requested"].includes(a.kind),
            )
            .map((a) => a.id)
            .sort()
        : [];
    return {
      ...summary(t, ids),
      environmentId: client.id,
      archivedAt: t.archivedAt,
      pinnedAt: t.pinnedAt,
      snoozedUntil: t.snoozedUntil,
    };
  };
  const execute = async (name, input, signal) => {
    const availableClients = desktop ? await desktop.clients(signal) : clients;
    const selectedDefault = desktop && availableClients.size === 1 ? availableClients.keys().next().value : defaultEnvironment;
    const route = (id) => {
      const client = availableClients.get(id ?? selectedDefault);
      if (!client) throw new Error("Unknown or missing environmentId. Use list_environments.");
      return client;
    };
    if (name === "list_environments")
      return {
        environments: [...availableClients.values()].map((c) => ({
          id: c.id,
          label: c.label,
          isDefault: c.id === selectedDefault,
        })),
      };
    if (name === "wait_threads") {
      const targets = input.targets.map((t) => ({
        ...t,
        client: route(t.environmentId ?? input.environmentId),
      }));
      const deadline = Date.now() + (input.timeoutSeconds ?? 60) * 1000;
      for (;;) {
        const round = new AbortController();
        // A zero wait still permits one network observation, bounded to one second.
        const budget = Math.max(
          1,
          input.timeoutSeconds === 0 ? 1000 : deadline - Date.now(),
        );
        const roundSignal = AbortSignal.any(
          [signal, round.signal, AbortSignal.timeout(budget)].filter(Boolean),
        );
        const observed = new Map();
        const unavailable = [];
        let hasReady = false;
        await Promise.all(
          [...new Set(targets.map((t) => t.client))].map(async (c) => {
            const entries = targets
              .map((t, i) => ({ ...t, index: i }))
              .filter((t) => t.client === c);
            try {
              const snapshot = await c.shell(roundSignal);
              await Promise.all(
                entries.map(async (t) => {
                  try {
                    const value = await summarize(
                      c,
                      find(snapshot, t.threadId),
                      roundSignal,
                    );
                    observed.set(t.index, value);
                    if (ready(value) && value.cursor !== t.cursor) {
                      hasReady = true;
                      round.abort();
                    }
                  } catch {
                    unavailable.push({
                      environmentId: c.id,
                      threadId: t.threadId,
                      reason: round.signal.aborted
                        ? "not-observed"
                        : roundSignal.aborted
                          ? "timeout"
                          : "unavailable",
                    });
                  }
                }),
              );
            } catch {
              for (const t of entries)
                if (!observed.has(t.index))
                  unavailable.push({
                    environmentId: c.id,
                    threadId: t.threadId,
                    reason: round.signal.aborted
                      ? "not-observed"
                      : roundSignal.aborted
                        ? "timeout"
                        : "unavailable",
                  });
            }
          }),
        );
        if (signal?.aborted) throw new Error("Wait cancelled.");
        const threads = [...observed.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, t]) => t);
        if (hasReady || unavailable.length || Date.now() >= deadline)
          return {
            threads,
            unavailable,
            timedOut: !hasReady && Date.now() >= deadline,
          };
        await delay(
          Math.min(pollIntervalMs, deadline - Date.now()),
          undefined,
          { signal },
        );
      }
    }

    const client = route(input.environmentId);
    let snapshot = ["list_providers", "create_project"].includes(name)
      ? undefined
      : await client.shell(signal);
    if (
      name === "list_archived_threads" ||
      input.includeArchived ||
      (input.threadId && !snapshot.threads.some((t) => t.id === input.threadId))
    ) {
      const archived = await client.rpc(
        "orchestration.getArchivedShellSnapshot",
        signal,
      );
      snapshot = {
        ...snapshot,
        threads: [...snapshot.threads, ...archived.threads],
      };
    }
    const project = (id) => {
      const p = snapshot.projects?.find((p) => p.id === id);
      if (!p) throw new Error("Project is unavailable.");
      return p;
    };
    if (name === "list_projects")
      return { environmentId: client.id, projects: snapshot.projects ?? [] };
    if (name === "list_providers") {
      const config = await client.rpc("server.getConfig", signal);
      return {
        environmentId: client.id,
        providers: config.providers.map((p) => ({
          instanceId: p.instanceId,
          driver: p.driver,
          displayName: p.displayName,
          installed: p.installed,
          enabled: p.enabled,
          status: p.status,
          authStatus: p.authStatus ?? p.auth?.status,
          models: p.models,
        })),
      };
    }
    if (name === "list_threads" || name === "list_archived_threads") {
      if (input.projectId) project(input.projectId);
      const all = snapshot.threads
        .filter(
          (t) =>
            (!input.projectId || t.projectId === input.projectId) &&
            (name === "list_archived_threads"
              ? t.archivedAt != null
              : input.includeArchived || t.archivedAt == null) &&
            (!input.beforeThreadId || t.id < input.beforeThreadId),
        )
        .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      const page = all.slice(0, input.limit ?? 20);
      return {
        environmentId: client.id,
        threads: await Promise.all(
          page.map((t) => summarize(client, t, signal)),
        ),
        nextBeforeThreadId: all.length > page.length ? page.at(-1).id : null,
      };
    }
    if (name === "read_thread") {
      if (find(snapshot, input.threadId).archivedAt != null)
        throw new Error(
          "T3 does not expose archived history. Unarchive the thread with set_thread_archived before reading it.",
        );
      let previous;
      for (let attempt = 0; attempt < 3; attempt++) {
        const t = find(snapshot, input.threadId);
        const detail = await detailed(client, t.id, input, signal);
        const sequence = detail.page?.threadSequence;
        if (
          snapshot.snapshotSequence !== detail.snapshotSequence &&
          !(sequence !== undefined && sequence === previous)
        ) {
          previous = sequence;
          if (attempt < 2) snapshot = await client.shell(signal);
          continue;
        }
        return {
          environmentId: client.id,
          thread: {
            ...summary(
              t,
              detail.thread.activities
                .filter((a) =>
                  ["approval.requested", "user-input.requested"].includes(
                    a.kind,
                  ),
                )
                .map((a) => a.id)
                .sort(),
            ),
            environmentId: client.id,
            archivedAt: t.archivedAt,
            pinnedAt: t.pinnedAt,
          },
          snapshotSequence: detail.snapshotSequence,
          page: detail.page,
          messages: detail.thread.messages.map((m) => ({
            id: m.id,
            role: m.role,
            text: m.text.slice(0, 8000),
            truncated: m.text.length > 8000,
            createdAt: m.createdAt,
          })),
          activities: detail.thread.activities
            .filter(
              (a, i, all) =>
                i >= all.length - 50 ||
                ["approval.requested", "user-input.requested"].includes(a.kind),
            )
            .map((a) => ({
              id: a.id,
              kind: a.kind,
              createdAt: a.createdAt,
              ...(a.kind === "approval.requested" ||
              a.kind === "user-input.requested"
                ? { payload: a.payload }
                : {}),
            })),
        };
      }
      throw new Error("Thread changed during read; retry.");
    }
    // Namespace retries by routing and operation so independent projects/targets cannot collide.
    const commandId =
      input.commandId === undefined
        ? randomUUID()
        : `mcp-global:${createHash("sha256")
            .update(
              JSON.stringify([
                client.id,
                name,
                input.projectId ?? null,
                input.threadId ?? null,
                input.source ?? null,
                input.commandId,
              ]),
            )
            .digest("hex")}`;
    const createdAt = new Date().toISOString();
    let command;
    if (name === "create_project")
      command = {
        type: "project.create",
        projectId: `mcp-project:${commandId}`,
        title: input.title,
        workspaceRoot: input.workspaceRoot,
        createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing,
        createdAt,
      };
    else if (name === "create_thread") {
      project(input.projectId);
      command = {
        type: "thread.create",
        threadId: `mcp-thread:${commandId}`,
        projectId: input.projectId,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode ?? "approval-required",
        interactionMode: input.interactionMode ?? "default",
        branch: null,
        worktreePath: null,
        createdAt,
      };
    } else {
      const t = find(snapshot, input.threadId);
      command = { threadId: t.id };
      switch (name) {
        case "send_message_to_thread": {
          let prefix = "";
          if (input.source) {
            const origin = route(input.source.environmentId);
            find(await origin.shell(signal), input.source.threadId);
            prefix = `Message from T3 thread ${input.source.threadId} on environment ${origin.id}.${input.replyToSource === false ? "" : ` Reply with send_message_to_thread using environmentId ${JSON.stringify(origin.id)} and threadId ${JSON.stringify(input.source.threadId)}.`}\n\n`;
          }
          Object.assign(command, {
            type: "thread.turn.start",
            message: {
              messageId: `mcp-message:${commandId}`,
              role: "user",
              attachments: [],
              text: prefix + input.message,
            },
            runtimeMode: t.runtimeMode,
            interactionMode: t.interactionMode,
            createdAt,
            ...(input.modelSelection
              ? { modelSelection: input.modelSelection }
              : {}),
          });
          break;
        }
        case "set_thread_title":
          Object.assign(command, {
            type: "thread.meta.update",
            title: input.title,
          });
          break;
        case "set_thread_archived":
          command.type = input.archived ? "thread.archive" : "thread.unarchive";
          break;
        case "set_thread_pinned":
          command.type = input.pinned ? "thread.pin" : "thread.unpin";
          break;
        case "set_thread_settled":
          Object.assign(command, {
            type: input.settled ? "thread.settle" : "thread.unsettle",
            ...(input.settled ? {} : { reason: "user" }),
          });
          break;
        case "set_thread_snoozed":
          Object.assign(
            command,
            input.snoozedUntil === null
              ? { type: "thread.unsnooze", reason: "user" }
              : { type: "thread.snooze", snoozedUntil: input.snoozedUntil },
          );
          break;
        case "delete_thread":
          command.type = "thread.delete";
          break;
        case "interrupt_thread":
          Object.assign(command, { type: "thread.turn.interrupt", createdAt });
          break;
        case "stop_thread_session":
          Object.assign(command, { type: "thread.session.stop", createdAt });
          break;
        case "respond_to_approval":
          Object.assign(command, {
            type: "thread.approval.respond",
            requestId: input.requestId,
            decision: input.decision,
            createdAt,
          });
          break;
        case "respond_to_user_input":
          Object.assign(command, {
            type: "thread.user-input.respond",
            requestId: input.requestId,
            answers: input.answers,
            createdAt,
          });
          break;
        case "dismiss_user_input":
          Object.assign(command, {
            type: "thread.user-input.dismiss",
            requestId: input.requestId,
            createdAt,
          });
          break;
        default:
          throw new Error("Unknown tool.");
      }
    }
    const receipt = await client.request(
      "/api/orchestration/dispatch",
      { ...command, commandId },
      signal,
    );
    return {
      environmentId: client.id,
      ...(command.threadId
        ? { threadId: command.threadId }
        : { projectId: command.projectId }),
      ...receipt,
    };
  };
  const ajv = new Ajv({ strict: false, validateFormats: false });
  const validators = new Map(
    globalTools.map((t) => [t.name, ajv.compile(t.inputSchema)]),
  );
  const server = new Server(
    { name: "t3code-thread-mcp", version: "0.3.0-next.1" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: globalTools,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const input = req.params.arguments ?? {};
    if (!validators.get(req.params.name)?.(input))
      throw new McpError(ErrorCode.InvalidParams, "Invalid tool arguments.");
    try {
      const result = await execute(req.params.name, input, extra.signal);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      const safe = [
        desktopUnavailable,
        "Unknown or missing environmentId. Use list_environments.",
        "Thread is unavailable.",
        "Project is unavailable.",
        "Thread changed during read; retry.",
        "T3 does not expose archived history. Unarchive the thread with set_thread_archived before reading it.",
      ];
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: safe.includes(error.message)
              ? error.message
              : "Thread operation failed.",
          },
        ],
      };
    }
  });
  return server;
}
