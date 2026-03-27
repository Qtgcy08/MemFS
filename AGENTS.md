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
# Syntax check (fast)
node --check index.js
node --check src/tfidf/hybridSearchService.js

# Full test suite (23 tests)
node test_mcp_full.mjs

# Git Sync tests
node test_gitsync.mjs

# Run specific test only - edit test file to isolate single test
# Open test_mcp_full.mjs and comment out other tests
```

### Test Files
| File | Purpose |
|------|---------|
| `test_mcp_full.mjs` | 23 tests for all MCP tools + Git Sync |
| `test_gitsync.mjs` | Git auto-commit scenarios |
| `debug_search.html` | Web UI for debugging searchNode (open in browser) |
| `test_cache/` | Isolated test directory with own git repo |

---

## Code Style

### Format
- **4 spaces** indent, **single quotes**, **semicolons**, max **100 chars/line**

### Imports (order: stdlib → third-party → local)
```javascript
import { execFileSync } from 'child_process';  // stdlib
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";  // third-party
import { SearchIntegrator } from './src/tfidf/searchIntegrator.js';  // local
```

### Naming
| Type | Convention | Example |
|------|------------|---------|
| Classes | PascalCase | `KnowledgeGraphManager` |
| Functions/Variables | camelCase | `loadGraph`, `memoryFilePath` |
| Constants | UPPER_SNAKE_CASE | `DEFAULT_FIELD_WEIGHTS`, `BM25_K1` |
| Schemas | PascalCase + Schema | `EntitySchema` |
| MCP Tools | snake_case | `searchNode`, `recycleObservation` |

### Hard Constraints
- **Never** suppress types: `as any`, `@ts-ignore`, `@ts-expect-error`
- **Never** leave code broken after failures
- **Never** delete failing tests to "pass"

### Error Handling
```javascript
catch (error) {
    if (error instanceof Error && error.code === "ENOENT") {
        return { entities: [], relations: [] };
    }
    throw error;
}
```
- Handle specific errors before generic re-throw
- Use `process.exit(1)` for fatal main() errors

---

## Architecture

### Data Model (JSONL)
```jsonl
{"type":"entity","name":"Weber","entityType":"person","definition":"...","observationIds":[1,2]}
{"type":"observation","id":1,"content":"...","createdAt":{"utc":"ISO8601","timezone":"Asia/Shanghai"},"updatedAt":{"utc":"ISO8601","timezone":"Asia/Shanghai"}}
{"type":"relation","from":"Weber","to":"Durkheim","relationType":"contemporary"}
```

### Filesystem-Inspired Design
| Concept | Implementation |
|---------|---------------|
| Inode Table | Centralized observation storage |
| Hard Links | Multi-entity observation sharing |
| Copy-on-Write | Updates create new observations |
| Orphan Detection | GC for unused observations |

---

## Search Architecture

### Tokenization (Unified Gram System)
Follows **The Bitter Lesson**: general methods over embedded knowledge.

```
Query: "明日方舟终末地 新中国风"
    ↓ cleanText() (remove punctuation)
    ↓ tokenizeQuery()
    ├── fullQuery: "明日方舟终末地新中国风" (penalty=1.0, exact match boost)
    ├── 2-gram: 明日, 日方, 方舟, 终末, 末地, 新中, 中国, 国风 (penalty=1.0)
    ├── 3-gram: 明日方, 日方舟, ... (penalty=0.368)
    ├── 4-gram: 明日方舟, ... (penalty=0.135)
    └── 5-gram+: increasingly penalized
```

**Gram Penalty**: `1/e^(n-2)` - longer grams decay to avoid dominating matches

### Field Weights (Single Source of Truth)
Defined in `hybridSearchService.js` as `DEFAULT_FIELD_WEIGHTS`:

| Field | BM25 Weight | Fuse Weight |
|-------|-------------|-------------|
| name | 5.0 | 5.0 |
| entityType | 2.5 | 2.5 |
| definition | 2.5 | 2.5 |
| definitionSource | 1.5 | 1.5 |
| observation | 3.0 | 3.0 |

### Scoring Pipeline
1. **Tokenize** query → gram tokens with penalties
2. **BM25 + Fuse** search independently (0.7 / 0.3)
3. **Aggregate** with field weights
4. **Boost** for fullQuery matches:
   - fullQuery + name match: **10x** (5x base + 2x fusion)
   - fullQuery + other field: **3x** (2x base + 1.5x fusion)
5. **Relation matching**: relation type matching query grams → 1.5x boost

### Relation Boost
When relation type matches query gram tokens:
- **Base score**: 0.5
- **Match boost**: 1.5 (when relation type contains any query gram)

---

## Key Patterns

### Tool Registration
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

### Console Logging
```javascript
// Auto-level detection based on message content
console.error('[GitSync] message');   // → level: 'info'
console.error('[MCP Server] message'); // → level: 'info'
console.error('[Stats] message');      // → level: 'info'
console.error('[Deprecation]...');     // → level: 'warn'
console.error('DETECTED: ...');        // → level: 'error'
```
- Use `console.error()` for server status
- Prefixes: `[GitSync]`, `[MCP Server]`, `[Stats]`, `DETECTED:`, `COMPLETED:`

### Git Auto-Commit (GITAUTOCOMMIT)
- Enabled via `GITAUTOCOMMIT=true` env var
- Auto-commits on every `saveGraph()` call
- Commit message: `chore: auto-sync (operation details) at UTC YYYY-MM-DDTHH:mm:ss.SSSZ`
- Operation context tracked via `lastOperation` in KnowledgeGraphManager

### Timestamp Format
- **Storage**: `{utc: "ISO8601", timezone: "IANA"}` (e.g., "Asia/Shanghai")
- **API response**: `"YYYY-MM-DD HH:mm:ss Timezone"` (local time with IANA zone)

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MEMORY_DIR` | Data storage directory | `~/.memory` |
| `MEMORY_FILE_PATH` | **DEPRECATED** - use MEMORY_DIR | - |
| `GITAUTOCOMMIT` | Enable git auto-commit | `false` |

---

## Publishing (use publish-new skill)
```bash
# Say: "使用 publish-new skill 发布新版本"
```

Version bump: feat→minor, fix→patch, BREAKING CHANGE→major

---

## Recent Changes (2026-03)

- **Gram Tokenization**: Unified 2~(n-1) gram system replacing language-specific rules
- **Gram Penalty**: `1/e^(n-2)` decay for longer grams
- **Field Weights**: Centralized in `DEFAULT_FIELD_WEIGHTS`
- **DefinitionSource**: Added to index with weight 1.5
- **Relation Boost**: Relation type matching query grams → 1.5x
- **Limit Fix**: Total entities (direct + related) now respect `limit` parameter
