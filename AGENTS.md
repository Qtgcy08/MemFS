# AGENTS.md

**MemFS** — Knowledge graph management system. One Node.js process, speaks stdio/SSE MCP.

**Stack:** Node.js 22+ ES Modules | MCP SDK 1.29.0 | Zod | Fuse.js 7.1.0 | Pure JS BM25

## Entrypoint & Tools

- `index.js` (~2250 lines) contains everything: `KnowledgeGraphManager` class, 17 MCP tool handlers, all utilities. No framework, no codegen.
- Tools: `createEntity` `createRelation` `addObservation` `deleteEntity` `deleteRelation` `unlinkObservation` `recycleObservation` `getOrphanObservation` `readNode` `readObservation` `listNode` `listGraph` `searchNode` `updateNode` `updateObservation` `howWork` `getConsole`
- `analyzeDuplicates` (optional, `--duplicates` flag): BM25 mean-similarity dedup tool for observations, entities, and relations
- `howWork` returns `skills/memfs_best_practices/SKILL.md` (lazy-loaded)
- `**XX**` in text fields (definition/observation) → BM25 ×1.5 weighted atomic token, no-gram, transparent to search
- Field weights: name 5.0, entityType 2.5, definition 2.5, definitionSource 1.5, observation 1.0

## Search Modules (src/tfidf/)

| File | Role |
|------|------|
| `hybridSearchService.js` | Orchestrator — BM25 + Fuse fusion, field weights |
| `bm25Search.js` | Pure JS BM25 with n-gram (2/3/4) tokenization |
| `fuseSearch.js` | Fuse.js 7.1.0 wrapper |
| `traditionalSearch.js` | Legacy keyword fallback (`legacyGrep` mode) |
| `searchIntegrator.js` | Routes to hybrid or traditional |

## entityType Multi-Dimensional Paths

`entityType` supports path syntax: `/修饰语/中心语/`, multiple paths via `|`. Older plain strings (`编程语言`) work unchanged.

- `listNode(tree=true)` returns directory tree instead of flat node list
- BM25 index extracts path nodes as atomic tokens to avoid n-gram boundary noise

## CLI Args (args > env)

| Arg | Env fallback | Description |
|-----|-------------|-------------|
| `--memory-dir <path>` | `MEMORY_DIR` | Data directory (default: `~/.memory`) |
| `--git-autocommit` | `GITAUTOCOMMIT=true` | Enable git auto-commit |
| `--mode sse` | — | SSE HTTP mode |
| `--port <n>` | — | SSE port (default 3100) |
| `--token <str>` | — | SSE auth token |
| `--duplicates` | — | Enable analyzeDuplicates tool (BM25 dedup, optional) |

## Testing

```bash
# Prerequisite
cp test_cache/mcp-client.js .

# Full suite (29 tests, skips SSE by default)
MEMORY_DIR=test_cache node test_mcp_full.mjs

# SSE tests (opt-in, requires http server)
TEST_SSE=true MEMORY_DIR=test_cache node test_mcp_full.mjs

# Git sync scenarios
node test_gitsync.mjs

# Hybrid search specific
node test_mcp_hybrid_search.mjs

# Fast syntax check
node --check index.js
node --check src/tfidf/bm25Search.js
```

Key testing quirks:
- SSE test spawns a real HTTP subprocess, skipped unless `TEST_SSE=true`
- `test_cache/` has its own git repo used as test fixture
- `mcp-client.js` helper must exist in project root

## Data Model (JSONL)

Three types: `entity` (with `observationIds` array), `observation` (shared inode table), `relation` (from→to→relationType).
- `createdAt`/`updatedAt`: stored as `{utc, timezone}`, API formats to `"YYYY-MM-DD HH:mm:ss IANA"`
- Observations are centrally stored, multi-entity via hard-link IDs; copy-on-write on updates

## MCP Tool Pattern

```javascript
return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
         jsonContent: result };
```
No `outputSchema`, no `structuredContent` — always `jsonContent`.

## Code Conventions

4 spaces, single quotes, semicolons, max 100 chars/line. Classes PascalCase, functions camelCase, MCP tools snake_case. `console.error()` prefixes: `[Git]` `[MCP Server]` `[Stats]`. No `as any` or `@ts-ignore`.

## VERSION

`const { version: VERSION } = require('./package.json')` (line 15 of `index.js`). No hardcoded copy.

## Branches

- `dev` — active development (v3.7.12)
- `master` — stable releases (v2.5.21, fast-forwarded from origin)
- `legacy` — v1.3.0 archive
