# AGENTS.md

**MemFS** - Knowledge graph management system with BM25 + fuzzy search. Inspired by filesystem concepts (inode, hard links, copy-on-write).

**Stack:** Node.js 22+ ES Modules | MCP SDK | Zod | Fuse.js 7.1.0 | Pure JS BM25

---

## Build, Lint, and Test

```bash
npm install

# Run server
node index.js

# With custom memory directory and git auto-commit
MEMORY_DIR=~/data GITAUTOCOMMIT=true node index.js
```

### Testing
```bash
# Syntax check (fast) on changed files
node --check index.js
node --check src/tfidf/traditionalSearch.js

# Full test suite (25 assertions across 17 MCP tools)
node test_mcp_full.mjs

# Git Sync tests
node test_gitsync.mjs

# Hybrid search specific tests
node test_mcp_hybrid_search.mjs
```

**Test prerequisite:** `test_cache/mcp-client.js` must be copied to root before running tests from project root:
```bash
cp test_cache/mcp-client.js . && MEMORY_DIR=test_cache node test_mcp_full.mjs
```

### Test Files
| File | Purpose |
|------|---------|
| `test_mcp_full.mjs` | 25 assertions across all MCP tools + Git Sync |
| `test_gitsync.mjs` | Git auto-commit scenarios |
| `test_mcp_hybrid_search.mjs` | Hybrid search specific tests |
| `test_cache/` | Isolated test directory with own git repo and mcp-client.js |
| `debug_search.html` | Web UI for debugging searchNode (open in browser) |

---

## Architecture

### All-in-One Entrypoint
`index.js` (~2250 lines) contains everything: `KnowledgeGraphManager` class, all 17 MCP tool handlers, utility functions, and timestamp formatting. No framework - just a single Node.js process that speaks stdio MCP.

### Search Modules (`src/tfidf/`)
| File | Role |
|------|------|
| `searchIntegrator.js` | Orchestrator - routes to hybrid or traditional search |
| `hybridSearchService.js` | BM25 + Fuse.js hybrid with gram tokenization; field weights in `DEFAULT_FIELD_WEIGHTS` |
| `bm25Search.js` | Pure JS BM25 implementation |
| `fuseSearch.js` | Fuse.js 7.1.0 wrapper |
| `traditionalSearch.js` | Legacy keyword match fallback |

### Data Model (JSONL)
```jsonl
{"type":"entity","name":"Weber","entityType":"person","definition":"...","observationIds":[1,2]}
{"type":"observation","id":1,"content":"...","createdAt":{"utc":"ISO8601","timezone":"Asia/Shanghai"},"updatedAt":{"utc":"ISO8601","timezone":"Asia/Shanghai"}}
{"type":"relation","from":"Weber","to":"Durkheim","relationType":"contemporary"}
```

`createdAt`/`updatedAt` are **sibling top-level properties** (not nested). Data layer returns raw `{utc, timezone}` objects; MCP tool handler layer formats to strings.

### Filesystem-Inspired Design
| Concept | Implementation |
|---------|---------------|
| Inode Table | Centralized observation storage |
| Hard Links | Multi-entity observation sharing |
| Copy-on-Write | Updates create new observations |
| Orphan Detection | GC for unused observations |

---

## Key Patterns

### MCP Tool Registration
```javascript
server.registerTool("tool_name", {
    title: "Tool Title",
    description: "Description",
    inputSchema: z.object({ ... }),
    outputSchema: z.object({ ... })
}, async ({ params }) => {
    const result = await manager.method(params);
    return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result
    };
});
```

### Timestamp Format
- **Storage**: `{utc: "ISO8601", timezone: "IANA"}` (e.g., "Asia/Shanghai")
- **API response**: `"YYYY-MM-DD HH:mm:ss Timezone"` (local time with IANA zone)
- Formatting: `formatTimestamp()` for single objects, `formatObservations()` for arrays
- `updatedAt` and `createdAt` are separate fields in storage - **both** must be mapped in data layer returns

### VERSION Sync
`index.js` line 16 has a **hardcoded** `const VERSION = "2.4.16"` that must be manually updated alongside `package.json`. They are out of sync after npm publish.

### Console Logging
Use `console.error()` with prefixes for auto-level detection:
- `[GitSync]`, `[MCP Server]`, `[Stats]` → info
- `[Deprecation]` → warn
- `DETECTED:` → error

### Git Auto-Commit (GITAUTOCOMMIT)
- Commit message: `auto-commit:[operationContext] at [utc:...] [tz:Asia/Shanghai]`
- Git author: `user.name: memfs-{VERSION}`, `user.email: username-memfs@hostname`

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MEMORY_DIR` | Data storage directory | `~/.memory` |
| `MEMORY_FILE_PATH` | **DEPRECATED** - use MEMORY_DIR | - |
| `GITAUTOCOMMIT` | Enable git auto-commit | `false` |

---

## Code Style

- **4 spaces**, **single quotes**, **semicolons**, max **100 chars/line**
- Imports order: stdlib → third-party → local
- Classes: PascalCase (`KnowledgeGraphManager`), functions/vars: camelCase
- Constants: UPPER_SNAKE_CASE (`DEFAULT_FIELD_WEIGHTS`, `BM25_K1`)
- MCP Tools: snake_case (`searchNode`, `recycleObservation`)
- Never suppress types (`as any`, `@ts-ignore`)
- Handle specific errors before generic re-throw; `process.exit(1)` for fatal main() errors

---

## Publishing (use publish-new skill)
```bash
# Say: "使用 publish-new skill 发布新版本"
```
Version bump: feat→minor, fix→patch, BREAKING CHANGE→major

Remember to also update `const VERSION = "..."` in `index.js` line 16.
