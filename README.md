# Java Jar Viewer MCP

MCP server that lets an LLM browse JAR contents, attach `*-sources.jar` source, and decompile `.class` files with CFR. It also runs Maven/Gradle dependency resolution to surface absolute paths for local artifacts.

## Prerequisites
- Node.js 18+
- Java 8+ on PATH (for CFR)
- Maven on PATH when using `scan_project_dependencies` for Maven projects
- Gradle Wrapper (`./gradlew`) or Gradle on PATH when using `scan_project_dependencies` for Gradle projects

## Install & Run
```bash
npm install
npm run build
node dist/index.js   # or add to your MCP registry
```

## Tools
- `list_jar_entries(jarPath, innerPath?)`: Lists up to 100 items from the JAR, folding by directory level for quick navigation.
- `read_jar_entry(jarPath, entryPath)`: Reads the requested entry. For `.class`, it first looks for a sibling `*-sources.jar` and otherwise decompiles with CFR; falls back to `javap` signatures if needed.
- `scan_project_dependencies(projectPath, excludeTransitive?, configurations?, includeLogTail?)`: Detects Maven/Gradle projects (by `pom.xml` or `build.gradle(.kts)`/`settings.gradle(.kts)`), then resolves absolute artifact paths. Uses `mvn dependency:list` for Maven, and an injected Gradle init script (`mcpListDeps`) for Gradle. Results are cached per project root.
  - `excludeTransitive`: set to `true` to return only first-level dependencies.
  - `configurations`: Gradle-only list of configuration names to include (e.g. `["runtimeClasspath"]`).
  - `includeLogTail`: set to `true` to include the last lines of build output for debugging.

`lib/cfr-0.152.jar` is bundled and copied into `dist/lib` during `npm run build`; paths are resolved at runtime via `import.meta.url` to avoid hard-coding.
