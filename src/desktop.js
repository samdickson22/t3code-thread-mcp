import { createHash, randomUUID } from "node:crypto";
import { connect } from "node:net";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { lstat } from "node:fs/promises";

export const desktopUnavailable =
  "T3 desktop connection bridge is unavailable. Open a bridge-enabled T3 desktop app, or check --desktop-state-dir.";
const requestFailed = "T3 desktop could not complete the connection operation.";

// Matches T3's shared/desktopAppControl address; never reads its credential store.
export function desktopAddress(
  stateDir = join(homedir(), ".t3", "userdata"),
  options = {},
) {
  const hash = createHash("sha256")
    .update(resolve(stateDir))
    .digest("hex")
    .slice(0, 24);
  if ((options.platform ?? process.platform) === "win32")
    return `\\\\.\\pipe\\t3code-app-${hash}`;
  const uid = options.userId ?? process.getuid?.() ?? hash.slice(0, 12);
  let temp = options.tempDir ?? tmpdir();
  // MCP hosts commonly omit TMPDIR; macOS GUI apps still use the per-user temp directory.
  if (
    options.tempDir === undefined &&
    process.platform === "darwin" &&
    !process.env.TMPDIR
  ) {
    try {
      temp =
        execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
          encoding: "utf8",
          timeout: 1000,
        }).trim() || temp;
    } catch {
      /* Use Node's default if the OS helper is unavailable. */
    }
  }
  return join(temp, `t3code-${uid}`, `${hash}.sock`);
}

export function createDesktopTransport({
  stateDir,
  address = desktopAddress(stateDir),
} = {}) {
  const call = async (operation, fields = {}, signal) => {
    if (process.platform === "win32")
      throw new Error("Desktop connection mode is currently available on macOS and Linux. Use direct connection configuration on Windows.");
    if (process.platform !== "win32") {
      try {
        const [directory, socket] = await Promise.all([
          lstat(dirname(address)),
          lstat(address),
        ]);
        const uid = process.getuid?.();
        if (
          !directory.isDirectory() ||
          directory.isSymbolicLink() ||
          !socket.isSocket() ||
          socket.isSymbolicLink() ||
          directory.mode & 0o077 ||
          (uid !== undefined && (directory.uid !== uid || socket.uid !== uid))
        )
          throw new Error();
      } catch {
        throw new Error(desktopUnavailable);
      }
    }
    return new Promise((resolveCall, reject) => {
      const requestId = randomUUID();
      const request =
        JSON.stringify({
          version: 1,
          requestId,
          type: "connection",
          operation,
          ...fields,
        }) + "\n";
      if (Buffer.byteLength(request) > 64 * 1024)
        return reject(new Error("Desktop bridge request is too large."));
      if (signal?.aborted) return reject(new Error(requestFailed));
      const socket = connect(address);
      let buffer = "",
        bytes = 0,
        settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        socket.destroy();
        error ? reject(error) : resolveCall(result);
      };
      const abort = () => finish(new Error(requestFailed));
      const timeout = setTimeout(
        () => finish(new Error(desktopUnavailable)),
        31000,
      );
      signal?.addEventListener("abort", abort, { once: true });
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(request));
      socket.on("error", () => finish(new Error(desktopUnavailable)));
      socket.on("close", () => finish(new Error(desktopUnavailable)));
      socket.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 8 * 1024 * 1024)
          return finish(
            new Error(
              "Desktop bridge response is too large. Request a smaller history page.",
            ),
          );
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline));
          if (
            response.version !== 1 ||
            response.requestId !== requestId ||
            typeof response.ok !== "boolean"
          )
            throw new Error();
          if (!response.ok)
            return finish(
              new Error(
                response.code === "invalid-request" ||
                response.code === "renderer-unavailable"
                  ? desktopUnavailable
                  : requestFailed,
              ),
            );
          if (!Object.hasOwn(response, "result")) throw new Error();
          finish(null, response.result);
        } catch {
          finish(new Error(requestFailed));
        }
      });
    });
  };
  return {
    async clients(signal) {
      const result = await call("listEnvironments", {}, signal);
      if (!Array.isArray(result?.environments)) throw new Error(requestFailed);
      const clients = new Map();
      for (const env of result.environments) {
        if (
          typeof env.id !== "string" ||
          !env.id ||
          typeof env.label !== "string" ||
          clients.has(env.id)
        )
          throw new Error(requestFailed);
        const invoke = (operation, fields, signal) =>
          call(operation, { environmentId: env.id, ...fields }, signal);
        clients.set(env.id, {
          id: env.id,
          label: env.label,
          shell: (signal) => invoke("shell", {}, signal),
          rpc: (method, signal) => {
            if (method === "server.getConfig")
              return invoke("providers", {}, signal);
            if (method === "orchestration.getArchivedShellSnapshot")
              return invoke("archived", {}, signal);
            throw new Error(requestFailed);
          },
          request: (path, body, signal) => {
            if (path === "/api/orchestration/shell" && body === undefined)
              return invoke("shell", {}, signal);
            if (path === "/api/orchestration/dispatch" && body !== undefined)
              return invoke("dispatch", { command: body }, signal);
            const match =
              /^\/api\/orchestration\/threads\/([^/?]+)\?(.+)$/.exec(path);
            if (!match || body !== undefined) throw new Error(requestFailed);
            const query = new URLSearchParams(match[2]);
            return invoke(
              "thread",
              {
                threadId: decodeURIComponent(match[1]),
                turnLimit: Number(query.get("turnLimit")),
                ...(query.has("beforeCursor")
                  ? { beforeCursor: query.get("beforeCursor") }
                  : {}),
              },
              signal,
            );
          },
        });
      }
      return clients;
    },
  };
}
