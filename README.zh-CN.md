# Java Jar Viewer MCP

MCP 服务，允许 LLM 浏览 JAR 内容，自动关联 `*-sources.jar` 源码并使用 CFR 反编译 `.class` 文件。同时支持 Maven/Gradle 依赖解析，输出本地 artifact 的绝对路径。

English doc: `README.md`.

## 前置条件
- Node.js 18+
- Java 8+（包含 `javap` 的 JDK，供 CFR 和 describe_class 使用）
- 使用 `scan_project_dependencies` 解析 Maven 工程时，需要 Maven 在 PATH 中
- 使用 `scan_project_dependencies` 解析 Gradle 工程时，需要 Gradle Wrapper（`./gradlew`）或 Gradle 在 PATH 中

## 快速开始（npx）
```bash
npx -y jar-viewer-mcp@latest
```

### MCP 配置片段
把以下内容加到你的 MCP 客户端/注册表中（示例格式）：
```json
{
  "mcpServers": {
    "jar-viewer": {
      "command": "npx",
      "args": ["-y", "jar-viewer-mcp@latest"]
    }
  }
}
```

## 安装方式
### 全局安装
```bash
npm install -g jar-viewer-mcp
jar-viewer-mcp
```

### 本地开发
```bash
npm install
npm run build
node dist/index.js
```

## 工具列表
- `list_jar_entries(jarPath, innerPath?)`：列出 JAR 中最多 100 个条目，并按目录层级折叠，便于快速浏览。
- `read_jar_entry(jarPath, entryPath)`：读取指定条目。对 `.class` 文件会优先查找同级 `*-sources.jar`，否则使用 CFR 反编译；必要时回退到 `javap` 方法签名。
- `describe_class(jarPath, className?, entryPath?, memberVisibility?, methodQuery?, limit?)`：使用 `javap` 获取类的方法签名（不进行反编译）。`memberVisibility="public"`（默认）或 `"all"`。
- `resolve_class(projectPath, className, dependencyQuery?, includeMembers?, memberVisibility?, methodQuery?, limit?)`：在项目依赖的 JAR 中定位类。`includeMembers=true` 时附带方法签名（与 `describe_class` 相同筛选条件）。
- `scan_project_dependencies(projectPath, excludeTransitive?, configurations?, includeLogTail?, query?)`：检测 Maven/Gradle 项目（`pom.xml` 或 `build.gradle(.kts)`/`settings.gradle(.kts)`），解析依赖并返回本地路径。Maven 使用 `mvn dependency:list`；Gradle 通过注入 init 脚本（`mcpListDeps`）。结果会按项目根目录缓存。`query` 对 `groupId:artifactId` 和路径做不区分大小写的子串匹配。
  - `excludeTransitive`：设为 `true` 时仅返回一级依赖。
  - `configurations`：Gradle 专用，指定要解析的配置（如 `["runtimeClasspath"]`）。
  - `includeLogTail`：设为 `true` 时包含构建输出末尾日志，便于排错。

`lib/cfr-0.152.jar` 已随包发布，并在 `npm run build` 时复制到 `dist/lib`；路径通过 `import.meta.url` 动态解析，避免硬编码。
