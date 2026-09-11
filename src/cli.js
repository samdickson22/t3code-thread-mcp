#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
try {
  const server = createServer({
    url: process.env.T3_URL,
    token: process.env.T3_ACCESS_TOKEN,
    sourceThreadId: process.env.T3_SOURCE_THREAD_ID,
  });
  await server.connect(new StdioServerTransport());
} catch {
  console.error(
    "Could not start T3 thread MCP. Set T3_URL, T3_ACCESS_TOKEN and T3_SOURCE_THREAD_ID.",
  );
  process.exitCode = 1;
}
