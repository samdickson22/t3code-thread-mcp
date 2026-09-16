import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createGlobalServer } from "../src/global-server.js";
test("single URL starts without source while explicit legacy source preserves scope", () => {
  const env = { T3_URL: "https://host.example", T3_ACCESS_TOKEN: "secret" };
  assert.deepEqual(loadConfig([], env), {
    environments: [
      { id: "default", label: "default", url: env.T3_URL, token: "secret" },
    ],
    defaultEnvironment: "default",
  });
  assert.equal(
    loadConfig([], { ...env, T3_SOURCE_THREAD_ID: "parent" }).sourceThreadId,
    "parent",
  );
});
test("multi-host config resolves only named environment secrets and rejects invalid routing", () => {
  const dir = mkdtempSync(join(tmpdir(), "t3-mcp-config-"));
  const path = join(dir, "config.json");
  const config = {
    environments: [
      { id: "a", url: "https://a.example", tokenEnv: "A_SECRET" },
      { id: "b", url: "https://b.example", tokenEnv: "B_SECRET" },
    ],
  };
  try {
    writeFileSync(path, JSON.stringify(config));
    const loaded = loadConfig(["--config", path], {
      A_SECRET: "a",
      B_SECRET: "b",
    });
    assert.equal(loaded.defaultEnvironment, undefined);
    assert.equal(loaded.environments[1].token, "b");
    for (const invalid of [
      { ...config, defaultEnvironment: "unknown" },
      { environments: [...config.environments, config.environments[0]] },
      { environments: [{ ...config.environments[0], token: "plaintext" }] },
    ]) {
      writeFileSync(path, JSON.stringify(invalid));
      assert.throws(() => loadConfig(["--config", path], {}));
    }
    assert.throws(() => loadConfig(["--config"], {}));
    assert.throws(() => loadConfig(["--wat"], {}));
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test("global connections reject credential URLs, remote HTTP and missing access tokens", () => {
  for (const url of [
    "http://remote.example",
    "https://user:password@host.example",
    "https://host.example?token=secret",
    "file:///tmp/x",
  ]) {
    assert.throws(() =>
      createGlobalServer({ environments: [{ id: "a", url, token: "secret" }] }),
    );
  }
  assert.throws(() =>
    createGlobalServer({
      environments: [{ id: "a", url: "https://host.example" }],
    }),
  );
});

test("inherited global config does not widen explicit legacy source scope", () => {
  assert.equal(
    loadConfig([], {
      T3_URL: "https://legacy.example",
      T3_ACCESS_TOKEN: "test",
      T3_SOURCE_THREAD_ID: "parent",
      T3_MCP_CONFIG: "/does-not-exist",
    }).sourceThreadId,
    "parent",
  );
});
