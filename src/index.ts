#!/usr/bin/env node

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFR_FILENAME = "cfr-0.152.jar";
const MAX_LIST_ENTRIES = 100;
const MAX_TEXT_BYTES = 200_000;

type JarEntrySummary = {
  path: string;
  directory: boolean;
  size: number;
  compressedSize: number;
};

type ListJarEntriesResult = {
  jarPath: string;
  innerPath: string;
  total: number;
  truncated: boolean;
  entries: JarEntrySummary[];
};

type ReadJarResult = {
  content: string;
  entryPath: string;
  source: "source" | "decompiled" | "resource" | "summary";
  sourceJar?: string;
};

type ProjectType = "maven" | "gradle" | "native";

type ProjectDetection = {
  type: ProjectType;
  root: string | null;
  markers: string[];
};

type DependencyInfo = {
  groupId: string;
  artifactId: string;
  type: string;
  classifier?: string | null;
  version: string;
  scope: string;
  path: string;
};

type DependencyResult = {
  projectPath: string;
  projectRoot: string | null;
  projectType: ProjectType;
  dependencies: DependencyInfo[];
  cached: boolean;
  logTail?: string;
};

type ScanDependenciesOptions = {
  projectPath: string;
  excludeTransitive?: boolean;
  configurations?: string[];
  includeLogTail?: boolean;
  query?: string;
};

type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  project: ProjectDetection;
};

type CommandOptions = {
  cwd?: string;
  projectPath?: string;
  shell?: boolean;
};

const listJarEntriesSchema = z.object({
  jarPath: z.string().min(1, "jarPath is required"),
  innerPath: z.string().optional(),
});

const readJarEntrySchema = z.object({
  jarPath: z.string().min(1, "jarPath is required"),
  entryPath: z.string().min(1, "entryPath is required"),
});

const scanDependenciesSchema = z.object({
  projectPath: z.string().min(1, "projectPath is required"),
  excludeTransitive: z.boolean().optional(),
  configurations: z.array(z.string().min(1)).optional(),
  includeLogTail: z.boolean().optional(),
  query: z.string().optional(),
});

function normalizeJarEntry(p?: string): string {
  if (!p) return "";
  return p.replace(/^[/\\]+/, "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizeConfigurations(configurations?: string[]): string[] {
  if (!configurations || configurations.length === 0) return [];
  const unique = new Set(
    configurations.map((value) => value.trim()).filter((value) => value.length > 0),
  );
  return Array.from(unique).sort((a, b) => a.localeCompare(b));
}

function normalizeQuery(value?: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

function filterDependenciesByQuery(
  dependencies: DependencyInfo[],
  query?: string,
): DependencyInfo[] {
  const normalized = normalizeQuery(query);
  if (!normalized) return dependencies;
  return dependencies.filter((dep) => {
    const name = `${dep.groupId}:${dep.artifactId}`.toLowerCase();
    if (name.includes(normalized)) return true;
    return dep.path.toLowerCase().includes(normalized);
  });
}

function buildDependencyCacheKey(
  projectRoot: string,
  options: { excludeTransitive?: boolean; configurations?: string[]; includeLogTail?: boolean },
): string {
  return JSON.stringify({
    projectRoot,
    excludeTransitive: Boolean(options.excludeTransitive),
    configurations: normalizeConfigurations(options.configurations),
    includeLogTail: Boolean(options.includeLogTail),
  });
}

function escapeGroovyString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function formatGroovyStringList(values?: string[]): string {
  const normalized = normalizeConfigurations(values);
  if (normalized.length === 0) return "[]";
  const items = normalized.map((value) => `"${escapeGroovyString(value)}"`);
  return `[${items.join(", ")}]`;
}

async function findProjectMarkers(dir: string, markers: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const marker of markers) {
    if (await fileExists(path.join(dir, marker))) {
      found.push(marker);
    }
  }
  return found;
}

async function detectProjectType(startPath: string): Promise<ProjectDetection> {
  let current = path.resolve(startPath);
  const stat = await fsPromises.stat(current).catch(() => null);
  if (stat?.isFile()) {
    current = path.dirname(current);
  }

  const mavenMarkers = ["pom.xml"];
  const gradleMarkers = ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"];

  while (true) {
    const foundMaven = await findProjectMarkers(current, mavenMarkers);
    if (foundMaven.length > 0) {
      return { type: "maven", root: current, markers: foundMaven };
    }

    const foundGradle = await findProjectMarkers(current, gradleMarkers);
    if (foundGradle.length > 0) {
      return { type: "gradle", root: current, markers: foundGradle };
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return { type: "native", root: null, markers: [] };
}

function requiredProjectTypeForCommand(command: string): ProjectType | "any" {
  const normalized = path.basename(command).toLowerCase();
  if (normalized === "mvn" || normalized === "mvn.cmd") return "maven";
  if (
    normalized === "gradle" ||
    normalized === "gradle.bat" ||
    normalized === "gradlew" ||
    normalized === "gradlew.bat"
  ) {
    return "gradle";
  }
  return "any";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function limitText(text: string, limit = MAX_TEXT_BYTES): { text: string; truncated: boolean } {
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, limit)}\n\n// [Truncated output at ${limit} characters]`,
    truncated: true,
  };
}

async function runCommand(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  const projectContext = options.projectPath ?? options.cwd ?? process.cwd();
  const project = await detectProjectType(projectContext);
  const requiredType = requiredProjectTypeForCommand(command);
  if (requiredType !== "any" && project.type !== requiredType) {
    const rootLabel = project.root ? ` (root: ${project.root})` : "";
    throw new Error(
      `Command "${command}" requires a ${requiredType} project, but detected ${project.type}${rootLabel}.`,
    );
  }

  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: options.shell ?? false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("error", (error) => reject(error));
    child.on("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        project,
      }),
    );
  });
}

function isEnoent(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT",
  );
}

async function resolveCfrJar(): Promise<string> {
  const candidates = [
    path.resolve(__dirname, "lib", CFR_FILENAME),
    path.resolve(__dirname, "../lib", CFR_FILENAME),
    path.resolve(process.cwd(), "lib", CFR_FILENAME),
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to locate ${CFR_FILENAME}. Ensure it is available in ./dist/lib or ./lib.`);
}

async function readEntryTextFromJar(jarPath: string, entryPath: string): Promise<string | null> {
  const normalizedEntry = normalizeJarEntry(entryPath);
  const zip = new AdmZip(jarPath);
  const entry = zip.getEntry(normalizedEntry);
  if (!entry || entry.isDirectory) {
    return null;
  }
  const data = entry.getData();
  const { text } = limitText(data.toString("utf-8"));
  return text;
}

function sourceJarPathFor(jarPath: string): string {
  const jarDir = path.dirname(jarPath);
  const baseName = path.basename(jarPath, ".jar");
  return path.join(jarDir, `${baseName}-sources.jar`);
}

function classNameFromEntry(entryPath: string): string {
  return normalizeJarEntry(entryPath)
    .replace(/\.class$/i, "")
    .replace(/\//g, ".")
    .replace(/^\.+/, "");
}

class JarViewerService {
  private dependencyCache = new Map<string, DependencyResult>();

  async listJarEntries(jarPath: string, innerPath?: string): Promise<ListJarEntriesResult> {
    const resolvedJar = path.resolve(jarPath);
    if (!(await fileExists(resolvedJar))) {
      throw new Error(`Jar file not found at ${resolvedJar}`);
    }

    const normalizedInner = normalizeJarEntry(innerPath);
    const zip = new AdmZip(resolvedJar);
    const directories = new Map<string, true>();
    const files: JarEntrySummary[] = [];

    for (const entry of zip.getEntries()) {
      const name = normalizeJarEntry(entry.entryName);
      if (!name) continue;
      if (normalizedInner) {
        if (name === normalizedInner) continue;
        if (!name.startsWith(`${normalizedInner}/`)) continue;
      }

      const relative = normalizedInner ? name.slice(normalizedInner.length).replace(/^\/+/, "") : name;
      if (!relative) continue;

      const [head, ...rest] = relative.split("/");
      if (!head) continue;

      if (rest.length > 0) {
        directories.set(`${head}/`, true);
      } else {
        files.push({
          path: head,
          directory: entry.isDirectory,
          size: entry.header?.size ?? 0,
          compressedSize: entry.header?.compressedSize ?? 0,
        });
      }
    }

    const entries = [
      ...Array.from(directories.keys()).map((dir) => ({
        path: dir,
        directory: true,
        size: 0,
        compressedSize: 0,
      })),
      ...files,
    ].sort((a, b) => a.path.localeCompare(b.path));

    const truncated = entries.length > MAX_LIST_ENTRIES;
    return {
      jarPath: resolvedJar,
      innerPath: normalizedInner || "/",
      total: entries.length,
      truncated,
      entries: entries.slice(0, MAX_LIST_ENTRIES),
    };
  }

  async readJarEntry(jarPath: string, entryPath: string): Promise<ReadJarResult> {
    const resolvedJar = path.resolve(jarPath);
    const normalizedEntry = normalizeJarEntry(entryPath);

    if (!(await fileExists(resolvedJar))) {
      throw new Error(`Jar file not found at ${resolvedJar}`);
    }

    if (!normalizedEntry) {
      throw new Error("entryPath is required");
    }

    const ext = path.extname(normalizedEntry).toLowerCase();
    if (ext !== ".class") {
      const resourceContent = await readEntryTextFromJar(resolvedJar, normalizedEntry);
      if (resourceContent === null) {
        throw new Error(`Entry ${normalizedEntry} not found in ${resolvedJar}`);
      }
      return {
        content: resourceContent,
        entryPath: normalizedEntry,
        source: "resource",
      };
    }

    const sourceResult = await this.tryReadFromSourceJar(resolvedJar, normalizedEntry);
    if (sourceResult) {
      return sourceResult;
    }

    return await this.decompileWithCfr(resolvedJar, normalizedEntry);
  }

  private async tryReadFromSourceJar(jarPath: string, entryPath: string): Promise<ReadJarResult | null> {
    const sourceJar = sourceJarPathFor(jarPath);
    if (!(await fileExists(sourceJar))) {
      return null;
    }

    const javaEntry = entryPath.replace(/\.class$/i, ".java");
    const content = await readEntryTextFromJar(sourceJar, javaEntry);
    if (content === null) {
      return null;
    }

    return {
      content: `// Source: Attached (${path.basename(sourceJar)})\n${content}`,
      entryPath: javaEntry,
      sourceJar,
      source: "source",
    };
  }

  private async decompileWithCfr(jarPath: string, entryPath: string): Promise<ReadJarResult> {
    const cfrJar = await resolveCfrJar();
    const className = classNameFromEntry(entryPath);
    const outputDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "jar-viewer-cfr-"));
    const jarFilter = `^${escapeRegExp(className)}$`;
    const outputJavaPath = path.join(outputDir, entryPath.replace(/\.class$/i, ".java"));

    try {
      let commandResult: CommandResult;
      try {
        commandResult = await runCommand(
          "java",
          [
            "-jar",
            cfrJar,
            jarPath,
            "--outputdir",
            outputDir,
            "--jarfilter",
            jarFilter,
            "--silent",
            "true",
          ],
          { projectPath: jarPath },
        );
      } catch (error) {
        if (isEnoent(error)) {
          throw new Error("Java runtime (java) was not found on PATH.");
        }
        throw error instanceof Error ? error : new Error(String(error));
      }

      const { code, stdout, stderr } = commandResult;

      if (code !== 0) {
        throw new Error(`CFR exited with code ${code}: ${stderr || stdout}`);
      }

      const javaSource = await fsPromises.readFile(outputJavaPath, "utf-8").catch(() => null);
      if (!javaSource) {
        const signature = await this.tryJavapSignature(jarPath, className);
        if (signature) {
          return {
            content: `// javap signature fallback\n${signature}`,
            entryPath,
            source: "summary",
          };
        }
        throw new Error(`CFR did not produce output for ${entryPath}`);
      }

      return {
        content: `// Decompiled via CFR\n${javaSource}`,
        entryPath: entryPath.replace(/\.class$/i, ".java"),
        source: "decompiled",
      };
    } finally {
      await fsPromises.rm(outputDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async tryJavapSignature(jarPath: string, className: string): Promise<string | null> {
    try {
      const { code, stdout, stderr } = await runCommand(
        "javap",
        ["-classpath", jarPath, "-public", className],
        { projectPath: jarPath },
      );
      if (code !== 0) {
        return null;
      }
      return stdout || stderr || null;
    } catch {
      return null;
    }
  }

  private async resolveGradleCommand(
    projectRoot: string,
  ): Promise<{ command: string; shell: boolean }> {
    const wrapperName = process.platform === "win32" ? "gradlew.bat" : "gradlew";
    const wrapperPath = path.join(projectRoot, wrapperName);
    if (await fileExists(wrapperPath)) {
      return { command: wrapperPath, shell: process.platform === "win32" };
    }
    return { command: "gradle", shell: false };
  }

  async scanProjectDependencies(options: ScanDependenciesOptions): Promise<DependencyResult> {
    const {
      projectPath,
      excludeTransitive = false,
      configurations,
      includeLogTail = false,
      query,
    } = options;
    const resolvedProject = path.resolve(projectPath);
    const projectInfo = await detectProjectType(resolvedProject);

    if (projectInfo.type === "native") {
      throw new Error(`No Maven or Gradle project detected at or above ${resolvedProject}.`);
    }

    const projectRoot = projectInfo.root ?? resolvedProject;
    const cacheKey = buildDependencyCacheKey(projectRoot, {
      excludeTransitive,
      configurations,
      includeLogTail,
    });
    const cached = this.dependencyCache.get(cacheKey);
    if (cached) {
      const filteredDependencies = filterDependenciesByQuery(cached.dependencies, query);
      return {
        ...cached,
        cached: true,
        projectPath: resolvedProject,
        projectRoot,
        projectType: projectInfo.type,
        dependencies: filteredDependencies,
      };
    }

    let result: DependencyResult;
    if (projectInfo.type === "maven") {
      result = await this.scanMavenDependencies(resolvedProject, projectRoot, {
        excludeTransitive,
        includeLogTail,
      });
    } else {
      result = await this.scanGradleDependencies(resolvedProject, projectRoot, {
        excludeTransitive,
        configurations,
        includeLogTail,
      });
    }

    this.dependencyCache.set(cacheKey, result);
    const filteredDependencies = filterDependenciesByQuery(result.dependencies, query);
    if (filteredDependencies === result.dependencies) {
      return result;
    }
    return {
      ...result,
      dependencies: filteredDependencies,
    };
  }

  private async scanMavenDependencies(
    resolvedProject: string,
    projectRoot: string,
    options: { excludeTransitive: boolean; includeLogTail: boolean },
  ): Promise<DependencyResult> {
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "jar-viewer-mvn-"));
    const outputFile = path.join(tempDir, "dependencies.txt");

    try {
      const mvnArgs = [
        "dependency:list",
        "-DoutputAbsoluteArtifactFilename=true",
        "-DincludeScope=runtime",
        "-DappendOutput=false",
        `-DoutputFile=${outputFile}`,
        "-B",
      ];
      if (options.excludeTransitive) {
        mvnArgs.push("-DexcludeTransitive=true");
      }

      const { code, stdout, stderr } = await runCommand("mvn", mvnArgs, {
        cwd: projectRoot,
        projectPath: projectRoot,
      });

      const fileContent = await fsPromises.readFile(outputFile, "utf-8").catch(() => "");
      if (code !== 0) {
        throw new Error(
          `mvn dependency:list failed with code ${code}. stderr: ${stderr || stdout || "no output"}`,
        );
      }

      const dependencies = parseMavenDependencyList(fileContent);
      const logTail = options.includeLogTail
        ? (stderr || stdout || "").trim().split("\n").slice(-10).join("\n")
        : undefined;
      const result: DependencyResult = {
        projectPath: resolvedProject,
        projectRoot,
        projectType: "maven",
        dependencies,
        cached: false,
        logTail,
      };
      return result;
    } catch (error) {
      if (isEnoent(error)) {
        throw new Error("Maven executable (mvn) was not found on PATH.");
      }
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async scanGradleDependencies(
    resolvedProject: string,
    projectRoot: string,
    options: { excludeTransitive: boolean; configurations?: string[]; includeLogTail: boolean },
  ): Promise<DependencyResult> {
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "jar-viewer-gradle-"));
    const initScriptPath = path.join(tempDir, "mcp-init.gradle");
    const allowedConfigs = formatGroovyStringList(options.configurations);
    const initScript = [
      `def mcpAllowedConfigs = ${allowedConfigs}`,
      `def mcpExcludeTransitive = ${options.excludeTransitive ? "true" : "false"}`,
      "allprojects {",
      "  task mcpListDeps {",
      "    doLast {",
      "      configurations.each { config ->",
        "        if (config.canBeResolved) {",
      "          if (!mcpAllowedConfigs.isEmpty() && !mcpAllowedConfigs.contains(config.name)) {",
      "            return",
      "          }",
      "          def artifacts = []",
      "          if (mcpExcludeTransitive) {",
      "            config.resolvedConfiguration.firstLevelModuleDependencies.each { dep ->",
      "              dep.moduleArtifacts.each { art ->",
      "                artifacts << art",
      "              }",
      "            }",
      "          } else {",
      "            artifacts = config.resolvedConfiguration.resolvedArtifacts",
      "          }",
      "          artifacts.each { art ->",
      "            def file = art.file",
      "            if (file != null) {",
      "              println \"MCP_DEP|${config.name}|${file.name}|${file.absolutePath}\"",
      "            }",
      "          }",
        "        }",
      "      }",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");

    try {
      await fsPromises.writeFile(initScriptPath, initScript, "utf-8");
      const { command, shell } = await this.resolveGradleCommand(projectRoot);
      const gradleArgs = ["--init-script", initScriptPath, "mcpListDeps", "-q"];

      const { code, stdout, stderr } = await runCommand(command, gradleArgs, {
        cwd: projectRoot,
        projectPath: projectRoot,
        shell,
      });

      if (code !== 0) {
        throw new Error(
          `gradle mcpListDeps failed with code ${code}. stderr: ${stderr || stdout || "no output"}`,
        );
      }

      const dependencies = parseGradleDependencyOutput(stdout);
      const logTail = options.includeLogTail
        ? (stderr || stdout || "").trim().split("\n").slice(-10).join("\n")
        : undefined;
      return {
        projectPath: resolvedProject,
        projectRoot,
        projectType: "gradle",
        dependencies,
        cached: false,
        logTail,
      };
    } catch (error) {
      if (isEnoent(error)) {
        throw new Error("Gradle executable (gradle/gradlew) was not found on PATH.");
      }
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function parseMavenDependencyList(output: string): DependencyInfo[] {
  const dependencies: DependencyInfo[] = [];
  const lines = output.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.replace(/^\[INFO\]\s+/, "").trim();
    if (!line || !line.includes(":")) continue;
    if (line.startsWith("---") || line.startsWith("The following")) continue;

    const parts = line.split(":");
    if (parts.length < 5) continue;

    const pathPart = parts.pop()!;
    const scope = parts.pop()!;
    const version = parts.pop()!;
    const classifier = parts.length > 3 ? parts.pop()! : null;
    const type = parts.pop() || "";
    const artifactId = parts.pop() || "";
    const groupId = parts.join(":");

    dependencies.push({
      groupId,
      artifactId,
      type,
      classifier,
      version,
      scope,
      path: pathPart,
    });
  }

  return dependencies;
}

type GradleDependencyEntry = {
  configuration: string;
  fileName: string;
  filePath: string;
};

function parseGradleDependencyOutput(output: string): DependencyInfo[] {
  const dependencies = new Map<string, DependencyInfo>();
  const lines = output.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("MCP_DEP|")) continue;
    const entry = parseGradleDependencyLine(line);
    if (!entry) continue;
    if (dependencies.has(entry.filePath)) continue;
    dependencies.set(entry.filePath, buildGradleDependencyInfo(entry));
  }

  return Array.from(dependencies.values());
}

function parseGradleDependencyLine(line: string): GradleDependencyEntry | null {
  const parts = line.split("|");
  if (parts.length < 4) return null;
  const configuration = parts[1]?.trim();
  const fileName = parts[2]?.trim();
  const filePath = parts.slice(3).join("|").trim();
  if (!configuration || !fileName || !filePath) return null;
  return { configuration, fileName, filePath };
}

type GradleCacheCoords = {
  groupId: string;
  artifactId: string;
  version: string;
  classifier: string | null;
};

function buildGradleDependencyInfo(entry: GradleDependencyEntry): DependencyInfo {
  const ext = path.extname(entry.fileName);
  const type = ext.replace(/^\./, "") || "jar";
  const baseName = path.basename(entry.fileName, ext);

  const cacheCoords = parseGradleCachePath(entry.filePath, entry.fileName);
  const groupId = cacheCoords?.groupId ?? "unknown";
  const artifactId = cacheCoords?.artifactId ?? (baseName || "unknown");
  const version = cacheCoords?.version ?? "unknown";
  const classifier = cacheCoords?.classifier ?? null;

  return {
    groupId,
    artifactId,
    type,
    classifier,
    version,
    scope: entry.configuration,
    path: entry.filePath,
  };
}

function parseGradleCachePath(filePath: string, fileName: string): GradleCacheCoords | null {
  const normalized = filePath.split(path.sep).join("/");
  const marker = "/modules-2/files-2.1/";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex === -1) return null;

  const rest = normalized.slice(markerIndex + marker.length);
  const parts = rest.split("/");
  if (parts.length < 4) return null;

  const groupId = parts[0];
  const artifactId = parts[1];
  const version = parts[2];
  if (!groupId || !artifactId || !version) return null;

  const ext = path.extname(fileName);
  const baseName = path.basename(fileName, ext);
  const prefix = `${artifactId}-${version}`;
  const classifier = baseName.startsWith(`${prefix}-`) ? baseName.slice(prefix.length + 1) : null;

  return { groupId, artifactId, version, classifier };
}

function formatToolResult(result: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result),
      },
    ],
  };
}

async function main() {
  const server = new McpServer(
    {
      name: "java-jar-viewer-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        "Use the provided tools to inspect JAR files. Prefer list_jar_entries before read_jar_entry to confirm exact paths.",
    },
  );

  const service = new JarViewerService();

  server.registerTool(
    "list_jar_entries",
    {
      title: "List JAR entries",
      description: "List top-level entries inside a JAR (folder-style view).",
      inputSchema: listJarEntriesSchema,
    },
    async ({ jarPath, innerPath }) => {
      const result = await service.listJarEntries(jarPath, innerPath);
      return formatToolResult(result);
    },
  );

  server.registerTool(
    "read_jar_entry",
    {
      title: "Read JAR entry",
      description:
        "Read a specific file from a JAR. For .class files, prefer attached source (-sources.jar). Falls back to CFR decompilation.",
      inputSchema: readJarEntrySchema,
    },
    async ({ jarPath, entryPath }) => {
      const result = await service.readJarEntry(jarPath, entryPath);
      return {
        content: [
          {
            type: "text",
            text: result.content,
          },
        ],
      };
    },
  );

  server.registerTool(
    "scan_project_dependencies",
    {
      title: "Scan project dependencies",
      description:
        "Resolve absolute paths for Maven/Gradle dependencies. Supports excludeTransitive, query, and Gradle configurations filters; cached per project root.",
      inputSchema: scanDependenciesSchema,
    },
    async (input) => {
      const result = await service.scanProjectDependencies(input);
      return formatToolResult(result);
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
