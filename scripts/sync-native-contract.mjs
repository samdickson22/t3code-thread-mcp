import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.env.T3_NATIVE_CHECKOUT;
if (!root)
  throw new Error(
    "Set T3_NATIVE_CHECKOUT to the native peer-thread branch checkout.",
  );
const load = (path) => import(pathToFileURL(resolve(root, path)).href);
const [{ ThreadsToolkit }, Tool, Context] = await Promise.all([
  load("apps/server/src/mcp/toolkits/threads/tools.ts"),
  load("apps/server/node_modules/effect/dist/unstable/ai/Tool.js"),
  load("apps/server/node_modules/effect/dist/Context.js"),
]);
const tools = Object.values(ThreadsToolkit.tools).map((tool) => ({
  name: tool.name,
  description: Tool.getDescription(tool),
  inputSchema: Tool.getJsonSchema(tool),
  annotations: {
    readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
    destructiveHint: Context.get(tool.annotations, Tool.Destructive),
    idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
    openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
  },
}));
const expected = JSON.stringify(tools, null, 2) + "\n";
const destination = new URL("../src/tools.json", import.meta.url);
if (process.argv.includes("--check")) {
  if ((await readFile(destination, "utf8")) !== expected)
    throw new Error("Native and standalone MCP contracts differ.");
  console.log("Native and standalone MCP contracts match exactly.");
} else await writeFile(destination, expected);
