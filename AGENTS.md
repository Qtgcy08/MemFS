# AGENTS.md

**MemFS** — Simple cross-process file lock, stdio/SSE MCP. Knowledge graph with filesystem-inspired data model.

**Stack:** Node.js 22+ ES Modules | MCP SDK 1.29.0 | Zod | Fuse.js 7.1.0 | Pure JS BM25

## Entrypoint & Tools

- `index.js` (~2300 lines) contains everything: `KnowledgeGraphManager`, `gitSync` object, 18 MCP tool handlers, all utilities. No framework, no codegen.
- Tools: `getConsole` `createEntity` `createRelation` `addObservation` `deleteEntity` `deleteRelation` `unlinkObservation` `recycleObservation` `getOrphanObservation` `readNode` `readObservation` `listNode` `listGraph` `searchNode` `updateNode` `updateObservation` `howWork`
- `analyzeDuplicates` (optional, `--duplicates` flag): BM25 mean-similarity dedup tool. Default threshold 0.8 (normalized).
- `howWork` returns `skills/memfs_best_practices/SKILL.md` (lazy-loaded)
- `**XX**` in text fields → BM25 ×1.5 weighted atomic token, transparent to search
- Field weights: name 5.0, entityType 2.5, definition 2.5, definitionSource 1.5, observation 1.0
- Tool registration uses `server.registerTool(name, { inputSchema: {...} }, handler)` (older SDK pattern)

## Search Modules (src/tfidf/)

| File | Role |
|------|------|
| `hybridSearchService.js` | Orchestrator — BM25 + Fuse fusion, field weights |
| `bm25Search.js` | Pure JS BM25 with n-gram (2/3/4) tokenization |
| `fuseSearch.js` | Fuse.js 7.1.0 wrapper |
| `traditionalSearch.js` | Legacy keyword fallback (`legacyGrep` mode) |
| `searchIntegrator.js` | Routes to hybrid/traditional search, hosts `analyzeDuplicates()` |
| `dedupWorker.js` | Worker thread module for dedup (parallel compute) |

## CLI Args (args > env)

| Arg | Env fallback | Description |
|-----|-------------|-------------|
| `--memory-dir <path>` | `MEMORY_DIR` | Data directory (default: `~/.memory`) |
| `--git-autocommit` | `GITAUTOCOMMIT=true` | Enable git auto-commit |
| `--mode sse` | — | Legacy SSE HTTP mode (`/sse` + `/message`) |
| `--mode http` | — | Streamable HTTP mode (`/mcp`) |
| `--mode both` | — | SSE + Streamable HTTP coexisting on one port |
| `--port <n>` | — | SSE port (default 3100) |
| `--token <str>` | — | SSE auth token |
| `--duplicates` | — | Enable analyzeDuplicates tool (optional) |
| `--autogc <N>` | — | Auto `git gc --auto` every N commits (default 20) |

## Model

Three JSONL types: `entity` (with `observationIds`), `observation` (shared inode table, hard-link semantics), `relation` (from→to→relationType).
- `createdAt`/`updatedAt`: stored as `{utc, timezone}`, API formats to `"YYYY-MM-DD HH:mm:ss IANA"`
- Observations are copy-on-write; duplicates by content share a single ID
- `createRelation` filters exact duplicates by (from, to, relationType) triple at API level
- MEMORY_DIR must be a directory path (not file path); server reads `memory.jsonl` inside it

## Concurrency

File lock via `fs.mkdir` atomicity (`.memory.lock/` + `info` PID file). Cross-process safe, works on Linux/macOS/Windows.
- Same-process: Promise queue serializes within one Node.js instance
- Cross-process: `mkdir` based exclusive lock, 10×300ms retry
- Stale lock: auto-stolen if >10s old and owner PID dead
- Lock auto-cleaned on SIGINT/SIGTERM/SIGHUP/exit

## gitSync

`gitSync` is a module-level object (not a class), created at `index.js:114`.
- `gcThreshold: 0`, `gcCounter: 0` — fire-and-forget async `git gc --auto` counter
- Auto-gc does not block the mutation pipeline; `execFile('git', ['gc', '--auto'])` is not awaited

## Code Conventions

4 spaces, single quotes, semicolons, max 100 chars/line. Classes PascalCase, functions camelCase, MCP tools snake_case. `console.error()` prefixes: `[Git]` `[MCP Server]` `[Stats]`. No `as any` or `@ts-ignore`.

Version: `const { version: VERSION } = require('./package.json')` (line 15). No hardcoded copy.

MCP tool response pattern — always `jsonContent` alongside `content[0].text`:
```javascript
return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
         jsonContent: result };
```

## Testing

```bash
# Full suite (29 tests, skips SSE by default)
MEMORY_DIR=test_cache node test_mcp_full.mjs

# SSE tests (opt-in)
TEST_SSE=true MEMORY_DIR=test_cache node test_mcp_full.mjs

# analyzeDuplicates (standalone, no MEMORY_DIR needed)
node test_mcp_dedup.mjs

# Hybrid search
MEMORY_DIR=test_cache node test_mcp_hybrid_search.mjs

# Streamable HTTP / coexistence (spawns real servers: --mode both/http/sse)
node test_mcp_streamable_http.mjs

# External write awareness (multi-instance shared JSONL, mtime-based reload)
node test_mcp_external_write.mjs

# Git sync scenarios (standalone)
node test_gitsync.mjs

# Fast syntax check
node --check index.js
node --check src/tfidf/bm25Search.js
```

Quirks:
- SSE test spawns a real HTTP subprocess, skipped unless `TEST_SSE=true`
- `test_cache/` is its own git repo, used as fixture for git tests; also in `.gitignore`
- `mcp-client.js` in root is the authoritative version; `test_cache/mcp-client.js` is a copy that must be kept in sync
- Dedup and gitsync tests are standalone (no MEMORY_DIR required) — they pre-write JSONL directly or use in-memory fixtures
- `test_cache/` is gitignored — changes there won't appear in `git status`

## Branches

- `dev` — active development (v3.7.12)
- `master` — stable releases (v2.5.21, fast-forwarded from origin)
- `legacy` — v1.3.0 archive
