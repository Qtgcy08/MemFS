# AGENTS.md

This document provides guidelines for agentic coding agents operating in this repository.

## Project Overview

**MemFS** - A knowledge graph management system based on MCP Memory Server with deep refactoring. Inspired by filesystem concepts (inode, hard links, copy-on-write).

**Key Technologies:**
- Node.js 22+ with ES Modules
- MCP (Model Context Protocol) SDK
- Zod for runtime validation
- 纯 JavaScript 实现 BM25（无外部依赖）
- Fuse.js 7.1.0 for fuzzy search

## Build, Lint, and Test Commands

### Installation
```bash
npm install
```

### Running the Server
```bash
node index.js
```

### Running with Custom Memory File
```bash
# Using directory
MEMORY_DIR=/path/to/data node index.js

# Using full file path
MEMORY_FILE_PATH=/path/to/memory.jsonl node index.js
```

### Testing
```bash
# Run full test suite (45 tests, < 2s)
node test_full.mjs

# Run hybrid search tests (38 tests)
node test_hybrid_search.mjs

# Run observation search tests
node test_observation_search.mjs
```

## Code Style Guidelines

### Language and Module System
- Use **ES Modules** (`import`/`export`) exclusively
- Use `.js` file extension with `"type": "module"` in package.json
- Avoid CommonJS `require()` syntax

### Imports
Order: stdlib → third-party → local. Use named imports:
```javascript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from 'fs';
import { HybridSearchService } from './hybridSearchService.js';
```

### Formatting
- **4 spaces** for indentation
- **Single quotes** for strings
- **Semicolons** at end of statements
- Max line length: 100 characters

### Naming Conventions
| Type | Convention | Example |
|------|------------|---------|
| Classes | PascalCase | `KnowledgeGraphManager`, `HybridSearchService` |
| Functions/Variables | camelCase | `loadGraph`, `memoryFilePath` |
| Constants | camelCase | `defaultMemoryPath` |
| Schemas | Suffix `Schema` | `EntitySchema` |
| Tool Names | snake_case | `create_entities` |
| MCP Tools | snake_case | `searchNode`, `recycleObservation` |
| Search Modules | Suffix `Searcher/Service` | `NaturalTfIdfSearcher`, `FuseSearcher` |

### Types and Data Structures
- Use **Zod** for all validation
- Use **async/await** for all async operations
- Use **Sets** for unique collections
- Use **Maps** for key-value lookups with complex keys

### Error Handling
```javascript
catch (error) {
    if (error instanceof Error && 'code' in error && error.code === "ENOENT") {
        return { entities: [], relations: [] };
    }
    throw error;
}
```
- Handle specific error codes before generic re-throw
- Use `process.exit(1)` for fatal main() errors

### Hard Constraints
- Never suppress type errors with `as any`, `@ts-ignore`, `@ts-expect-error`
- Never leave code in broken state after failures
- Never delete failing tests to "pass"

### JSONL Data Format

**New Format (Recommended):**
```jsonl
{"type":"entity","name":"Example","entityType":"concept","definition":"...","definitionSource":null,"observationIds":[1,2]}
{"type":"observation","id":1,"content":"...","createdAt":{"utc":"2026-02-08T13:53:07Z","timezone":"Asia/Shanghai"},"updatedAt":{"utc":"2026-02-09T15:30:00Z","timezone":"Asia/Shanghai"}}
{"type":"relation","from":"A","to":"B","relationType":"connected_to"}
```

**Legacy Formats (Backward Compatible):**
```jsonl
{"type":"observation","id":1,"content":"...","createdAt":"2026-02-08 21:53:07+0800"}
{"type":"observation","id":2,"content":"...","createdAt":"2026-02-08T13:53:07Z"}
```

### Timestamp Handling

**Storage Format (New):**
```javascript
{
    utc: "2026-02-09T14:02:06Z",      // UTC ISO 8601
    timezone: "Asia/Shanghai",         // IANA timezone identifier
    updatedAt: {                       // Optional, only set on updates (Copy-on-Write)
        utc: "2026-02-09T15:30:00Z",
        timezone: "Asia/Shanghai"
    }
}
```

**API Response Format:**
- Returns local time with IANA timezone identifier
- Example: `"2026-02-09 22:02:06 Asia/Shanghai"`
- Legacy string formats are returned as-is (for backward compatibility)

### Timestamp Helper Functions

**Core Functions (index.js):**

| Function | Purpose | Returns |
|----------|---------|---------|
| `getSystemTimezone()` | Get IANA timezone from system | `"Asia/Shanghai"`, `"UTC"`, etc. |
| `getCurrentTimestamp()` | Create timestamp for storage | `{utc, timezone}` object |
| `formatWithTimezone()` | Convert UTC to local time | `"YYYY-MM-DD HH:mm:ss Timezone"` |
| `formatTimestamp()` | Format timestamp for API response | `{value, type}` object |
| `formatObservationTimestamp()` | Format observation timestamps | `{createdAt, updatedAt}` object |

**formatTimestamp Return Format:**
```javascript
// New format with updatedAt
formatTimestamp({utc, timezone, updatedAt}) 
// Returns: { value: "2026-02-09 22:02:06 Asia/Shanghai", type: "updatedAt" }

// New format without updatedAt
formatTimestamp({utc, timezone}) 
// Returns: { value: "2026-02-09 22:02:06 Asia/Shanghai", type: "createdAt" }

// Legacy formats (returned as-is)
formatTimestamp("2026-02-08T13:53:07Z") 
// Returns: { value: "2026-02-08T13:53:07Z", type: "createdAt" }

formatTimestamp("2026-02-08 21:53:07+0800") 
// Returns: { value: "2026-02-08 21:53:07+0800", type: "createdAt" }
```

### Tool Registration Pattern
```javascript
server.registerTool("tool_name", {
    title: "Tool Title",
    description: "Clear description",
    inputSchema: { /* zod */ },
    outputSchema: { /* zod */ }
}, async ({ params }) => {
    const result = await manager.method(params);
    return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: { ...result }
    };
});
```

### Response Format
```javascript
// searchNode returns (simplified for LLM - _meta is internal debug only):
{
    entities: [...],
    relations: [...],
    observations: [...],
    searchMode: 'hybrid' | 'traditional'
}
```

### Console Output
- Use `console.error()` for server status
- Use descriptive prefixes: `"DETECTED:"`, `"COMPLETED:"`
- Avoid `console.log()` in production

## BM25 Search Architecture

### Module Structure
```
src/tfidf/
├── searchIntegrator.js       # Integration layer, routes to appropriate search
├── hybridSearchService.js    # Core: tokenization → BM25 → Fuse.js → aggregate → fuse
├── bm25Search.js           # BM25 搜索（纯 JavaScript 实现）
├── fuseSearch.js             # Fuzzy search using Fuse.js
└── traditionalSearch.js      # Legacy keyword matching (backward compat)
```

### Field Weights
| Field | Weight | Rationale |
|-------|--------|-----------|
| name | 5.0 | Highest - entity identifier |
| entityType | 4.0 | Category information |
| definition | 4.0 | Detailed description |
| observation | 3.0 | Supplementary info - enhanced for relevance |

### Search Configuration
```javascript
{
    bm25Weight: 0.7,   // Primary ranking
    fuzzyWeight: 0.3,   // Typo tolerance
    limit: 15,          // Default result limit
    minScore: 0.01      // Minimum relevance threshold
}
```

### Query Processing Flow
1. **Tokenization**: Split by whitespace, filter < 2 chars, deduplicate
2. **Multi-search**: Each token searched independently (BM25 + Fuse.js, topK=50)
3. **Aggregation**: Merge results, deduplicate entities, track matched terms
4. **Fusion**: Weighted score = (0.7×BM25 + 0.3×Fuse) × log₂(1 + matchedTerms)
5. **Output**: Entities sorted by relevance, no scores exposed to LLM

### Index Management
- Index built lazily on first search request
- Call `searchIntegrator.rebuildIndex()` after data modifications
- Status available via `searchIntegrator.getStatus()`

## Design Patterns

### Filesystem-Inspired Architecture
| Filesystem Concept | Knowledge Graph Implementation |
|-------------------|-------------------------------|
| Inode Table | Centralized observation storage |
| Hard Links | Multi-entity observation sharing |
| Soft Links | Entity relations |
| Copy-on-Write | Safe shared observation updates |
| Orphan Detection | Garbage collection for unused observations |

### Key Features
1. **Observation Centralization**: Observations stored separately, referenced by ID
2. **Copy-on-Write**: Updates to shared observations create new copies
3. **Hybrid Search**: BM25 (0.7) + Fuse.js (0.3) with query tokenization
4. **Backward Compat**: `basicFetch=true` for traditional keyword matching

## Testing Guidelines

### Test File Pattern
- Use `.mjs` extension for ESM compatibility
- Import from index.js: `import { KnowledgeGraphManager } from './index.js';`
- Use simple assertion pattern
- Include section headers for readability

### Cache Strategy
- 30-second TTL cache for `loadGraph()`
- `_clearCache()` called after `saveGraph()`
- Improves read performance significantly

### Windows Compatibility
- File locks not supported on Windows (EBUSY error)
- Acceptable for MCP server (single-process usage)
- Documented with humor in code comments

## Publishing

### Using publish-new Skill
This project uses the `publish-new` skill for automated releases. To publish:

```bash
# Trigger the skill by saying:
# "使用 publish-new skill 发布新版本"
```

The skill will:
1. Analyze git diff to determine version bump (feat→minor, fix→patch, BREAKING CHANGE→major)
2. Update package.json version
3. Commit to GitHub
4. Publish to npm

### Manual Publishing
```bash
# Update version in package.json
npm version patch  # or minor/major

# Publish to npm
npm publish

# Push to GitHub
git push origin master
```

### Version Rules
| Change Type | Version Bump | npm Publish |
|-------------|--------------|-------------|
| feat | minor | ✅ Yes |
| fix | patch | ✅ Yes |
| BREAKING CHANGE | major | ✅ Yes |
| docs/chore | none | ❌ GitHub only |
