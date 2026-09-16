import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createDesktopTransport,
  desktopAddress,
  desktopUnavailable,
} from "../src/desktop.js";
import { loadConfig } from "../src/config.js";

test("desktop stdio uses live app catalog and routes commands without server credentials", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "t3-desktop-test-"));
  const address = desktopAddress(stateDir);
  await mkdir(dirname(address), { recursive: true, mode: 0o700 });
  let environments = [{ id: "remote", label: "T3 Connect computer" }];
  const requests = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      data += chunk;
      if (!data.includes("\n")) return;
      const r = JSON.parse(data.slice(0, data.indexOf("\n")));
      requests.push(r);
      let result;
      if (r.operation === "listEnvironments") result = { environments };
      else if (r.operation === "shell")
        result = {
          snapshotSequence: 1,
          projects: [{ id: "project", workspaceRoot: "/remote/project" }],
          threads: [],
        };
      else if (r.operation === "providers")
        result = {
          providers: [
            { instanceId: "codex", authStatus: "authenticated", models: [] },
          ],
        };
      else if (r.operation === "dispatch") result = { sequence: 2 };
      else throw Error("Unexpected operation");
      socket.end(
        JSON.stringify({
          version: 1,
          requestId: r.requestId,
          ok: true,
          result,
        }) + "\n",
      );
    });
  });
  await new Promise((r) => server.listen(address, r));
  const client = new Client({ name: "desktop-test", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["src/cli.js", "--desktop", "--desktop-state-dir", stateDir],
        env: { PATH: process.env.PATH },
      }),
    );
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert(!result.isError, JSON.stringify(result));
      return result.structuredContent;
    };
    assert.equal(
      (await call("list_environments")).environments[0].id,
      "remote",
    );
    assert.equal(
      (await call("list_providers")).providers[0].authStatus,
      "authenticated",
    );
    const created = await call("create_thread", {
      title: "New remote thread",
      projectId: "project",
      commandId: "test-create",
      modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
    });
    assert.equal(created.environmentId, "remote");
    const dispatch = requests.find((r) => r.operation === "dispatch");
    assert.equal(dispatch.environmentId, "remote");
    assert.equal(dispatch.command.type, "thread.create");
    assert(!JSON.stringify(requests).includes("Bearer"));
    environments = [{ id: "another", label: "Newly connected computer" }];
    assert.equal(
      (await call("list_environments")).environments[0].id,
      "another",
    );
    const missing = await client.callTool({
      name: "list_projects",
      arguments: { environmentId: "remote" },
    });
    assert(missing.isError);
    assert.equal(requests.filter((r) => r.operation === "shell").length, 1);
  } finally {
    await client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => server.close(r));
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("desktop adapter cancels sockets and rejects wrong response identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t3-desktop-protocol-"));
  const address = join(dir, "test.sock");
  let wrong = true,
    closed;
  const server = createServer((socket) => {
    socket.on("data", () => {
      if (wrong)
        socket.end(
          JSON.stringify({
            version: 1,
            requestId: "other",
            ok: true,
            result: {},
          }) + "\n",
        );
      else {
        socket.on("close", () => closed());
        controller.abort();
      }
    });
  });
  const controller = new AbortController();
  await new Promise((r) => server.listen(address, r));
  try {
    const desktop = createDesktopTransport({ address });
    await assert.rejects(desktop.clients(), /could not complete/);
    wrong = false;
    const close = new Promise((r) => {
      closed = r;
    });
    await assert.rejects(desktop.clients(controller.signal));
    await close;
  } finally {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});

test("desktop mode explicitly overrides inherited server configuration and reports missing app", async () => {
  assert.deepEqual(
    loadConfig(["--desktop"], {
      T3_URL: "https://other",
      T3_SOURCE_THREAD_ID: "parent",
    }),
    { desktop: {} },
  );
  assert.throws(() => loadConfig(["--desktop", "--config", "x"], {}));
  await assert.rejects(
    createDesktopTransport({
      address: join(tmpdir(), "missing-t3-" + Date.now() + ".sock"),
    }).clients(),
    { message: desktopUnavailable },
  );
  assert.match(
    desktopAddress("/test/userdata", { platform: "win32" }),
    /^\\\\\.\\pipe\\t3code-app-[a-f0-9]{24}$/,
  );
});
