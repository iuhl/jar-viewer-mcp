# Java Jar Viewer MCP

MCP server that lets an LLM browse JAR contents, attach `*-sources.jar` source, and decompile `.class` files with CFR. It also runs Maven dependency resolution to surface absolute paths for local artifacts.

## Prerequisites
- Node.js 18+
- Java 8+ on PATH (for CFR)
- Maven on PATH when using `scan_project_dependencies`

## Install & Run
```bash
npm install
npm run build
node dist/index.js   # or add to your MCP registry
```

## Tools
- `list_jar_entries(jarPath, innerPath?)`: Lists up to 100 items from the JAR, folding by directory level for quick navigation.
- `read_jar_entry(jarPath, entryPath)`: Reads the requested entry. For `.class`, it first looks for a sibling `*-sources.jar` and otherwise decompiles with CFR; falls back to `javap` signatures if needed.
- `scan_project_dependencies(projectPath)`: Runs `mvn dependency:list -DoutputAbsoluteArtifactFilename=true` and returns resolved artifact paths (cached per project directory).

`lib/cfr-0.152.jar` is bundled and copied into `dist/lib` during `npm run build`; paths are resolved at runtime via `import.meta.url` to avoid hard-coding.
