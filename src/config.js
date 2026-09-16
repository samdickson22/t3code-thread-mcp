import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export function loadConfig(args = process.argv.slice(2), env = process.env) {
  if (args.length && (args.length !== 2 || args[0] !== "--config"))
    throw new Error("Usage: --config PATH");
  const index = args.indexOf("--config");
  if (index >= 0 && (args.length !== 2 || index !== 0 || !args[1]))
    throw new Error("Usage: --config PATH");
  if (index < 0 && env.T3_SOURCE_THREAD_ID && env.T3_URL) {
    return {
      url: env.T3_URL,
      token: env.T3_ACCESS_TOKEN,
      sourceThreadId: env.T3_SOURCE_THREAD_ID,
    };
  }
  const explicit = index >= 0 ? args[index + 1] : env.T3_MCP_CONFIG;
  const path =
    explicit ?? join(homedir(), ".config", "t3code-thread-mcp", "config.json");
  if (explicit || (!env.T3_URL && existsSync(path))) {
    const config = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(config.environments) || !config.environments.length)
      throw new Error("Configure at least one environment.");
    const ids = new Set();
    const environments = config.environments.map((e) => {
      if (
        !e.id ||
        typeof e.id !== "string" ||
        ids.has(e.id) ||
        typeof e.tokenEnv !== "string" ||
        !e.tokenEnv ||
        e.token !== undefined
      )
        throw new Error(
          "Each environment needs a unique id, url and tokenEnv.",
        );
      ids.add(e.id);
      return {
        id: e.id,
        label: e.label ?? e.id,
        url: e.url,
        token: env[e.tokenEnv],
      };
    });
    if (
      config.defaultEnvironment !== undefined &&
      !ids.has(config.defaultEnvironment)
    )
      throw new Error("Unknown defaultEnvironment.");
    return {
      environments,
      defaultEnvironment:
        config.defaultEnvironment ??
        (environments.length === 1 ? environments[0].id : undefined),
    };
  }
  if (!env.T3_URL)
    throw new Error(
      "Set T3_URL and T3_ACCESS_TOKEN, or configure environments with --config PATH. No parent thread is required.",
    );
  return env.T3_SOURCE_THREAD_ID
    ? {
        url: env.T3_URL,
        token: env.T3_ACCESS_TOKEN,
        sourceThreadId: env.T3_SOURCE_THREAD_ID,
      }
    : {
        environments: [
          {
            id: "default",
            label: "default",
            url: env.T3_URL,
            token: env.T3_ACCESS_TOKEN,
          },
        ],
        defaultEnvironment: "default",
      };
}
