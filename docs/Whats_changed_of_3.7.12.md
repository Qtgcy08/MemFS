# MemFS 3.7.12 更新详情

---

## 一、版本信息

| 项目 | 内容 |
|------|------|
| 起始版本 | v2.5.21 (deaebfb) |
| 最新版本 | v3.7.12 (3e1083f) |
| 提交总数 | 25 个 |
| 文件改动 | 16 文件, +4412 / −3105 |
| 新增核心代码 | ~1600 行（搜索层重构 + Worker查重 + CLI参数 + SSE） |

---

## 二、提交列表

| # | Commit | 消息 |
|---|--------|------|
| 1 | 5188971 | feat: add SSE mode with token auth, fix concurrency race condition |
| 2 | 5124662 | refactor: basicFetch → legacyGrep |
| 3 | a59c20a | feat: howWork returns SKILL.md best practices |
| 4 | f63b44c | chore: read VERSION from package.json |
| 5 | bf2fad0 | chore: bump version to 3.7.12 on dev branch |
| 6 | 5fa62c5 | chore: remove deprecated MEMORY_FILE_PATH, rename response field, normalize line endings |
| 7 | 9d64880 | feat: add CLI args --memory-dir and --git-autocommit with args>env priority |
| 8 | d168c1b | fix: parseToolResult also checks jsonContent for MCP SDK compatibility |
| 9 | c5bb7ae | fix: add missing spawn import for SSE test |
| 10 | 7dffb97 | feat: entityType multi-dimensional path + listNode file tree |
| 11 | f2a557a | test: skip SSE by default, enable with TEST_SSE=true |
| 12 | e43cfc5 | feat: **XX** bold semantic mark tag + SKILL.md simplify |
| 13 | 3b663d1 | feat: analyzeDuplicates BM25 mean-similarity dedup tool |
| 14 | 81a2a9b | perf: parallelize analyzeDuplicates with worker threads |
| 15 | f9d869e | test: add analyzeDuplicates MCP test suite (26 tests) |
| 16 | 39a36ee | fix: hybrid test MEMORY_DIR path (directory not .jsonl file) |
| 17 | 22f6043 | feat: normalize dedup similarity scores to 0-1 (like searchNode) |
| 18 | ece563c | fix: default analyzeDuplicates threshold 0.8 (from 0.4) |
| 19 | 12447db | feat: add distribution histogram to analyzeDuplicates result |
| 20 | 225ae9b | chore: add MemFS/ to .gitignore |
| 21 | 6d94efd | v3.7.12 easter egg tribute & AGENTS.md refresh |
| 22 | 2ef0b0a | listNode default to tree view; update opencode.json |
| 23 | 3e1083f | time param cleanup: omit null timestamp fields |

---

## 三、版本号彩蛋

```
v3.7.12 = 7/12 = 洛天依诞生日（7月12日）
```

版本号本身就是致敬。

getConsole(easterEgg=true) 会输出：
- `🎸 乐正司百曲，绫动万年红 —— 阿绫11周年生日快乐！[v2.4.12]`
- `🎤 华风夏韵，洛水天依 —— 洛天依14周年生日快乐！[v3.7.12]`

---

## 四、功能更新分类

### 1. CLI 参数体系（args > env > default）

**背景：** MEMORY_DIR / GITAUTOCOMMIT 环境变量迁移为 CLI 参数，支持配置文件化管理。

| 参数 | 环境变量 | 优先级 | 说明 |
|------|---------|--------|------|
| `--memory-dir <path>` | `MEMORY_DIR` | args > env | 数据目录（默认 `~/.memory`） |
| `--git-autocommit` | `GITAUTOCOMMIT=true` | args > env | 启用 Git 自动提交 |
| `--mode sse` | — | — | SSE HTTP 模式 |
| `--port <n>` | — | args | SSE 端口（默认 3100） |
| `--token <str>` | — | args | SSE 认证 token |
| `--duplicates` | — | flag | 启用 analyzeDuplicates 查重工具 |
| `--autogc <N>` | — | args | Git gc 自动触发（默认 20 次 commit） |

**技术细节：**
- 在 `main()` 入口解析 argv 并覆写对应 env 变量
- 零外部依赖变动
- 兼容旧有环境变量配置（作为 fallback）

---

### 2. SSE 模式

**基于 MCP SDK 的 SSEServerTransport 实现 HTTP SSE 传输层。**

```javascript
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
```

**特性：**
- `--mode sse --port 3100 --token mytoken` 启动
- `--token` 提供 Bearer token 认证
- AstrBot 通过 URL 带 token 连接
- Docker 热升级不受影响

**测试：**
- `test_concurrency_sse.mjs`：13 项测试（6 并发 + 7 SSE 认证）
- SSE 测试默认跳过，通过 `TEST_SSE=true` 环境变量启用

---

### 3. entityType 多维路径

**文件系统路径风格的多维度分类。**

格式约定：
```
/社会学/人物/|/经济学/人物/
```

**功能：**
- Zod transform 自动格式化路径（首尾斜杠 / | 分割 / 去重）
- 旧的简单类型（如 `"经济概念"`）向后兼容
- BM25 索引提取路径节点作为原子 token，避免 n-gram 噪声
- `listNode(tree=true)` 返回目录树，含 `_count` 密度指示

**BPE 先验验证：**
- `/` = token 14（词表前 0.014%）
- `|` = token 91（词表前 0.091%）
- 两者均为极端高频独立 token，LLM 预训练已内化层级语义

**后续可选：** 同目录 Boost（路径节点交集加权推荐）

---

### 4. **XX** 语义标记

**Markdown 加粗作为语义标签，同时服务渲染 + 检索 + LLM Attention。**

```javascript
function extractBoldTokens(text) {
    // 提取 **XX** 标记，BM25 权重 ×1.5
    const boldRegex = /\*\*(.+?)\*\*/g;
    // ** 不写入索引，XX 正文作为完整原子 token
}
```

**特性：**
- 零 Schema 改动、零存储格式变更
- `**XX**` 在 BM25 索引中视为 1 个原子 token，不经过 n-gram 拆解
- BM25 命中时权重 ×1.5
- `**` = token 334，BPE 词表独立成词

**ROI 分析：**
- `**理想类型**` = 6 tokens（2 个 `**` + 4 个中文）
- JSON tags 等效：`"tags": ["理想类型"]` = 9 tokens
- 投入 2 token 买 BM25 ×1.5 加权 + 渲染加粗 + Attention 内联

---

### 5. howWork → SKILL.md

**背景：** Prompts 组件的 AI 主动调用限制。

**设计决策：**
- Prompts 设计为 user-controlled（slash command），AI 无法主动调用
- `howWork` 保持为 MCP Tool，懒加载返回 `skills/memfs_best_practices/SKILL.md` 全文
- 双轨策略：Skill 支持的客户端自动加载 SKILL.md，其他通过 howWork 兜底

---

### 6. 并发安全锁

**进程内锁 (v3.7.12)：**
- `_lockQueue` Promise 链式互斥，串行化同一实例内的 load-modify-write 周期
- 替代原来 `saveGraph()` 内的空操作锁

**跨进程文件锁：**
- `fs.mkdir` 原子锁（`.memory.lock/`），支持多 Node.js 实例共享 JSONL
- 10×300ms 重试，PID + 超时检测自动回收过期锁
- SIGINT/SIGTERM/SIGHUP/exit 时自动清理

---

### 7. outputSchema 移除

全部 18 个工具注册的 `outputSchema` 字段删除。MCP SDK 1.29.0 不再需要输出 schema 声明。

---

### 8. getConsole 增强

- `reloadnow=true`：清除缓存 + 从磁盘重载 + 重建搜索索引
- git 日志默认 20 → 15
- Console 消息去重（Set + trim）
- Easter egg 彩蛋输出

---

### 9. analyzeDuplicates（Phase 2 核心）

**基于 BM25 均值相似度的语义查重工具，通过 `--duplicates` CLI flag 按需启用。**

**算法：**
```
Sim(A,B) = ΣBM25(g,B) / |Grams(A)|
```

**支持的三种范围：**
- **observation**：观察内容间的语义重复
- **entity**：实体名称 / 定义 / definitionSource 的相似度
- **relation**：精确匹配重复（createRelation 已在 API 层过滤精确重复）

**并行架构：**
```javascript
// 观察 + 实体 workers 并发执行
const allWorkers = [];
// obs workers + ent workers → Promise.all(allWorkers)
```

**性能：**
- 324 实体 / 2761 观察全量扫描 ~17.8s
- Worker 线程并行（obs ∥ ent），~30% 优于串行
- 零新增外部依赖，完全复用 2+3+4-gram 倒排索引

**分布校准（归一化 0-1）：**

| 区间 | 占比 | 含义 |
|------|------|------|
| 0.80+ | 4.4% | 真重复（name 子集匹配 / definitionSource 同值） |
| 0.40-0.80 | 71.6% | definitionSource 同值导致的浅层语义关联 |
| <0.40 | 24.0% | 无实质重复 |

**默认阈值：** 0.8（归一化），去除 90% 噪声

**开发过程中记录的 7 个 bug：**
1. MEMORY_DIR 路径混淆（相对路径跳到了家目录）
2. obsMap 键格式不匹配（裸 ID vs docId）
3. entityDocMap 观察污染（实体比较膨胀 4×4→12×12）
4. createRelation 精确去重屏蔽关系查重测试
5. addObservation 内容级去重屏蔽观察查重测试
6. MCP client stdout/stderr 混淆 + JSON-RPC handler 注册时机
7. Worker 串行 vs 并发调度

---

### 10. --autogc 自动 GC 计数器

**背景：** 大量 auto-commit 导致 git 仓库膨胀。

**机制：**
- 每次 autoCommit 后 `gcCounter++`
- 达到 `gcThreshold`（默认 20）时异步执行 `git gc --auto`
- Fire-and-forget 模式，不阻塞变异管线

```javascript
runGc() {
    if (this.gcThreshold <= 0) return;
    this.gcCounter++;
    if (this.gcCounter < this.gcThreshold) return;
    this.gcCounter = 0;
    execFile('git', ['gc', '--auto'], { cwd: this.memoryDir }, ...);
}
```

---

### 11. Git 仓库同步

master 分支从 v2.4.16 快速前进至 v2.5.21（deaebfb），补齐 13 个丢失 commit。

---

### 12. listNode 默认文件树

`listNode()` 默认返回 entityType 目录树（`tree=true`），展示知识图谱分类结构和 _count 密度指示。

---

### 13. time 参数清理

6 个工具的 time 参数行为统一：

| 工具 | time=false | time=true |
|------|-----------|-----------|
| listGraph | 无时间字段 | 有 createdAt/updatedAt? |
| readNode | 无时间字段 | 有 createdAt/updatedAt? |
| getOrphanObservation | 无时间字段 | 有 createdAt/updatedAt? |
| readObservation | 无时间字段 | 有 createdAt/updatedAt? |
| updateObservation | 无时间字段 | 有 createdAt/updatedAt? |
| searchNode | 无时间字段 | 有 createdAt/updatedAt? |

`updatedAt` 仅在非 null 时输出，不占空间。

---

### 14. MCP 客户端重构

`mcp-client.js`：

- `createMCPClient(env, args)` 支持 CLI 参数传递
- 启动检测从 stdout 移到 stderr（服务器 log 走 stderr）
- JSON-RPC handler 在 spawn 后立即注册，避免数据丢失
- 统一 stdout handler，消除数据竞争

---

### 15. 入口守卫修复

`process.argv[1]` 传入目录路径时与 `import.meta.url` 严格相等失败。
修复：同时匹配 `path.join(dir, 'index.js')`，覆盖 `node dir/` 和 `node dir/index.js` 两种调用方式。

同步更新 `test-helpers.mjs`：用 `InMemoryTransport` 替换子进程，测试速度提升 4 倍（18 测试 341ms）。

---

## 五、测试体系

| 测试文件 | 测试数 | 说明 |
|---------|--------|------|
| `test_mcp_full.mjs` | 29 | 全量 MCP 工具测试，SSE opt-in |
| `test_mcp_dedup.mjs` | 31 | analyzeDuplicates 专项测试 |
| `test_mcp_hybrid_search.mjs` | 16 | 混合搜索 + `**XX**` 标记 |
| `test_gitsync.mjs` | 10 | Git 同步场景测试 |
| `test_concurrency_sse.mjs` | 13 | 并发 + SSE 认证 |

---

## 六、代码改动统计

| 分类 | 文件 | 改动量 |
|------|------|--------|
| 搜索层重构 | `src/tfidf/*.js` | 6 文件, ~2000 行 |
| 查重工具 | `src/tfidf/dedupWorker.js` | +237 行 (新增) |
| CLI 参数 + SSE + 并发锁 | `index.js` | +760 / −583 行 |
| MCP 客户端 | `mcp-client.js` | +235 行 (重写) |
| 测试 | `test_*.mjs` | 6 文件, ~1400 行 |
| 文档 | `AGENTS.md`, `skills/*` | ~500 行 |

---

## 七、设计哲学

### 符号选择原则

三符号（`**` / `/` / `|`）均选用 BPE 词表前排独立 token：
- 不发明解析规则
- 不写自定义 parser
- 把语法语义外包给预训练阶段

这是《苦涩的教训》在 token 层面的翻译——Scaling Raw 从算法侧平移到数据侧的延伸。

### MCP Schema 作为笼子

CLI 给了 AI 万能钥匙，MCP Schema 则是把权力关进制度的笼子里。这是政治课智慧在工程实践中的体现——死板的 Schema 在安全场景中恰好是优点。

---

## 八、EOF

> 华风夏韵，洛水天依 ❤️
