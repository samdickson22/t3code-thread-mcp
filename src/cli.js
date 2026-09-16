#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { createGlobalServer } from "./global-server.js";
import { loadConfig } from "./config.js";
import { createDesktopTransport } from "./desktop.js";
if (process.argv.includes("--help")) {
  console.log(
    `t3code-thread-mcp [--config PATH | --desktop-state-dir PATH]\n\nGlobally installed MCP server for configured T3 computers. No parent thread required.\nBy default, reuses the running bridge-enabled T3 desktop app and its connected computers.\nSet T3_URL and T3_ACCESS_TOKEN for one computer, or use --config PATH / T3_MCP_CONFIG.\nDefault config: ~/.config/t3code-thread-mcp/config.json\nOptional T3_SOURCE_THREAD_ID enables legacy project-scoped mode.\nTransport: stdio.`,
  );
} else {
  try {
    const config = loadConfig();
    const server = config.desktop
      ? createGlobalServer({ desktop: createDesktopTransport(config.desktop) })
      : config.environments
      ? createGlobalServer(config)
      : createServer(config);
    await server.connect(new StdioServerTransport());
  } catch {
    console.error(
      "Could not start T3 thread MCP. Open a bridge-enabled T3 desktop app or check configured URLs and access-token environment variables. Use --help. No parent thread is required.",
    );
    process.exitCode = 1;
  }
}
