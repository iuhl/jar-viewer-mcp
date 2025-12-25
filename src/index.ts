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

type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  project: ProjectDetection;
};

type CommandOptions = {
  cwd?: string;
  projectPath?: string;
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
  if (normalized === "mvn") return "maven";
  if (normalized === "gradle" || normalized === "gradlew") return "gradle";
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

  async scanProjectDependencies(projectPath: string): Promise<DependencyResult> {
    const resolvedProject = path.resolve(projectPath);
    const projectInfo = await detectProjectType(resolvedProject);

    if (projectInfo.type === "gradle") {
      throw new Error(
        `Gradle project detected at ${projectInfo.root ?? resolvedProject}. Not supported yet.`,
      );
    }

    if (projectInfo.type !== "maven") {
      throw new Error(`No Maven project detected at or above ${resolvedProject}.`);
    }

    const projectRoot = projectInfo.root ?? resolvedProject;
    const cached = this.dependencyCache.get(projectRoot);
    if (cached) {
      return {
        ...cached,
        cached: true,
        projectPath: resolvedProject,
        projectRoot,
        projectType: projectInfo.type,
      };
    }

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
      const result: DependencyResult = {
        projectPath: resolvedProject,
        projectRoot,
        projectType: projectInfo.type,
        dependencies,
        cached: false,
        logTail: (stderr || stdout || "").trim().split("\n").slice(-10).join("\n"),
      };
      this.dependencyCache.set(projectRoot, result);
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

function formatToolResult(result: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
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
      title: "Scan Maven dependencies",
      description:
        "Run Maven dependency:list to resolve absolute paths for project dependencies. Cached per project path.",
      inputSchema: scanDependenciesSchema,
    },
    async ({ projectPath }) => {
      const result = await service.scanProjectDependencies(projectPath);
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
