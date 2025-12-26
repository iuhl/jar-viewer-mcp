#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const argv = process.argv.slice(2);
const help = argv.includes("--help") || argv.includes("-h");

if (help) {
  console.log(`Usage:
  node scripts/mcp-test.mjs [toolName] [jsonArgs]

Examples:
  node scripts/mcp-test.mjs scan_project_dependencies '{"projectPath":"/path/to/project"}'
  node scripts/mcp-test.mjs list_jar_entries '{"jarPath":"/path/to/app.jar","innerPath":"com/example"}'

Defaults:
  toolName = scan_project_dependencies
  jsonArgs = {"projectPath": "<cwd>"} or MCP_TEST_PROJECT_PATH if set
`);
  process.exit(0);
}

const toolName = argv[0] || "scan_project_dependencies";
let toolArgs = {};

if (argv[1]) {
  try {
    toolArgs = JSON.parse(argv[1]);
  } catch (error) {
    console.error("Failed to parse jsonArgs. Pass a valid JSON string.");
    console.error(String(error));
    process.exit(1);
  }
} else if (toolName === "scan_project_dependencies") {
  toolArgs = { projectPath: process.env.MCP_TEST_PROJECT_PATH || process.cwd() };
}

if (toolName === "scan_project_dependencies" && !toolArgs.projectPath) {
  console.error("scan_project_dependencies requires projectPath.");
  process.exit(1);
}

const serverPath = process.env.MCP_SERVER_PATH || path.resolve("dist/index.js");
if (!fs.existsSync(serverPath)) {
  console.error("MCP server not found at:", serverPath);
  console.error("Run `npm run build` first, or set MCP_SERVER_PATH.");
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: "node",
  args: [serverPath],
});

const client = new Client({ name: "mcp-test", version: "0.1.0" }, { capabilities: {} });

try {
  await client.connect(transport);
  const result = await client.callTool({ name: toolName, arguments: toolArgs });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error("MCP tool call failed.");
  console.error(String(error));
  process.exitCode = 1;
} finally {
  await client.close();
}
