# 🧠 MemFS

**A knowledge graph management system based on MCP server-memory, deeply refactored with filesystem-inspired design**

> 💡 Acknowledgments: [Original @modelcontextprotocol/server-memory](https://www.npmjs.com/package/@modelcontextprotocol/server-memory)  
> Inspired by it, though heavily reimagined.

[![Node.js 22+](https://img.shields.io/badge/node-22+-green?style=for-the-badge&logo=node.js)](https://nodejs.org)

---

## 🎯 One-Line Description

**Bringing modern filesystem concepts to knowledge graph management, combined with BM25 + fuzzy search for intelligent retrieval, designed for LLM-assisted humanities and social sciences research.**

> 📖 **中文版文档**: [docs/README_zh-CN.md](./docs/README_zh-CN.md)

---

## 🚀 Quick Start

### Prerequisites

```bash
# Check Node.js version
node --version  # Must be v22.0.0 or higher
```

### Installation & Run

**Quickest way (npx):**
```bash
npx @qty/memfs
```

**Or clone and run:**
```bash
# 1. Clone or download the project
cd MemFS

# 2. Install dependencies
npm install

# 3. Run server
node index.js

# Or specify custom storage directory
MEMORY_DIR=~/my-knowledge
```

### Configure as MCP Server

**OpenCode format:**
```json
{
  "mcpServers": {
    "memory": {
      "type": "local",
      "command": ["npx", "-y", "@qty/memfs"],
      "enabled": true
    }
  }
}
```

**VSCode / ClaudeCode / Cherry Studio / AstrBot format:**
```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@qty/memfs"],
      "enabled": true
    }
  }
}
```

---

## 📖 Core Concepts

| Concept | Description | Analogy |
|---------|-------------|---------|
| **Entity** | Nodes in the knowledge graph | File |
| **Observation** | Properties/descriptions of entities | inode |
| **Relation** | Connections between entities | Soft link |
| **Reference** | Pointers from entities to observations | Hard link |

---

## 💡 Core Design Philosophy

### 1. Transformer-Ready: On-Demand Retrieval

```mermaid
flowchart TD
    LLM["LLM"]
    ATT["Attention Mechanism"]
    MCP["MCP Protocol"]
    MEM["MemFS\nOn-demand structured data"]

    LLM --> ATT --> MCP --> MEM
    MEM -.-> |Returns results| LLM
```

**Core principle**: Don't stuff all knowledge into context—retrieve on demand.

### 2. Lightweight Design

| Dimension | Traditional Solution | MemFS |
|-----------|---------------------|-------|
| Deployment | Database + Vector Engine | Pure Node.js |
| Resources | GPU recommended, high memory | CPU only |
| Explainability | Black-box models | BM25 transparent & controllable |

### 3. Local JSONL Storage

```jsonl
{"type":"entity","name":"Weber","entityType":"person","definition":"German sociologist","observationIds":[1,2]}
{"type":"observation","id":1,"content":"Author of 'The Protestant Ethic'","createdAt":{"utc":"2026-02-08T13:53:07Z","timezone":"Asia/Shanghai"}}
{"type":"relation","from":"Weber","to":"Durkheim","relationType":"contemporary"}
```

**Advantages**: Editable with any text editor, Git-version-controllable, printable.

### 4. Humanities & Social Sciences Customization

| Requirement Type | Traditional | MemFS |
|-----------------|-------------|-------|
| Knowledge units | Functions/Classes | Concepts/People/Documents |
| Relationship types | Function calls | Influence/Reference/Comparison |
| Update frequency | High-frequency | Low-frequency add, high-frequency reference |

---

## 📦 Complete API Tools (16 total)

### Create

| Tool | Function | Example |
|------|----------|---------|
| `createEntity` | Batch create entities (with observations) | Add concepts, people, documents |
| `createRelation` | Create relations between entities | Mark references, comparisons, influences |
| `addObservation` | Add observations to existing entities | Supplement reading notes |

### Read

| Tool | Function | Example |
|------|----------|---------|
| `searchNode` | BM25 + Fuzzy hybrid search | Intelligent knowledge search |
| `readNode` | Read complete entity information | Get detailed attributes and relations |
| `readObservation` | Batch read observations by ID | Verify specific observations |
| `listNode` | List all entity overviews | Browse knowledge structure |
| `listGraph` | Read entire knowledge graph | Batch export, migration |
| `howWork` | Get recommended workflow guidance | Learn how to use the system |

### Update

| Tool | Function | Example |
|------|----------|---------|
| `updateNode` | Update entities and observations (Copy-on-Write) | Modify definitions, update notes |
| `updateObservation` | Batch update observation content | Batch correct information |

### Delete

| Tool | Function | Example |
|------|----------|---------|
| `deleteEntity` | Delete entities and relations | Remove outdated entries |
| `deleteRelation` | Delete specific relations | Unlink entities |
| `deleteObservation` | Unlink observations (preserve observation) | Remove references |
| `getOrphanObservation` | Find orphan observations | Discover invalid data |
| `recycleObservation` | Permanently delete observations | Clean up unused data |

---

## 🔍 Hybrid Search (searchNode)

### Core Features

| Feature | Description |
|---------|-------------|
| **BM25** | Considers term frequency and document frequency |
| **Fuzzy Search** | Tolerates typos, supports approximate matching |
| **Query Tokenization** | Tokenize → Search individually → Aggregate → Deduplicate |
| **Weighted Fusion** | BM25 0.7 + Fuzzy 0.3, combined ranking |

### Parameters

```javascript
// Default hybrid search
await searchNode("functionalism");  // BM25 + Fuzzy

// Traditional keyword search
await searchNode("functionalism", { basicFetch: true });

// Custom parameters
await searchNode("sociology", {
    limit: 15,          // Return count
    bm25Weight: 0.7,    // BM25 weight
    fuzzyWeight: 0.3,   // Fuzzy search weight
    minScore: 0.01      // Minimum relevance threshold
});
```

### Field Weights

| Field | Weight | Description |
|-------|--------|-------------|
| name | 5.0 | Highest - entity name |
| entityType | 4.0 | Entity type |
| definition | 4.0 | Definition description |
| observation | 3.0 | Observation content |

---

## 🔧 Filesystem-Inspired Design

### Architecture Analogy

| Filesystem Concept | MemFS Implementation | Solves |
|-------------------|---------------------|--------|
| **Inode Table** | Centralized observation storage | Data redundancy |
| **Hard Links** | Multiple entities reference same observation | Shared reuse |
| **Soft Links** | Entity relations | Flexible associations |
| **Copy-on-Write** | Copy-on-Write updates | Concurrency safety |
| **Orphan Detection** | Orphan observation cleanup | Resource recovery |

### Observation Sharing

```javascript
// Create two entities sharing the same observation
await createEntity([
  { name: "Zhang San", observations: ["Programmer"] },
  { name: "Li Si", observations: ["Programmer"] }
]);

// Under the hood: same observation ID is reused
{
  entities: [
    { name: "Zhang San", observationIds: [1] },
    { name: "Li Si", observationIds: [1] }
  ],
  observations: [
    { id: 1, content: "Programmer" }
  ]
}
```

### Copy-on-Write

```javascript
// Update a shared observation
await updateNode({
  entityName: "Zhang San",
  observationUpdates: [
    { oldContent: "Programmer", newContent: "Senior Programmer" }
  ]
});

// Result: Zhang San gets new observation, Li Si keeps original
{
  observations: [
    { id: 1, content: "Programmer" },      // Li Si uses
    { id: 2, content: "Senior Programmer" } // Zhang San's new observation
  ]
}
```

---

## 📁 Data Format

### JSONL Storage

```jsonl
{"type":"entity","name":"Weber","entityType":"person","definition":"German sociologist","definitionSource":"Wikipedia","observationIds":[1,2]}
{"type":"observation","id":1,"content":"Author of 'The Protestant Ethic'","createdAt":{"utc":"2026-02-08T13:53:07Z","timezone":"Asia/Shanghai"}}
{"type":"observation","id":2,"content":"Contemporary with Durkheim and Marx","createdAt":{"utc":"2026-02-08T14:00:00Z","timezone":"Asia/Shanghai"}}
{"type":"relation","from":"Weber","to":"Durkheim","relationType":"contemporary"}
```

### Storage Locations

| Method | Path |
|--------|------|
| Default | `~/.memory/memory.jsonl` |
| Custom directory | `MEMORY_DIR=/path/to/data` |

---

## 🧪 Testing

```bash
# Full test suite (45 tests)
node test_full.mjs

# Hybrid search tests (38 tests)
node test_hybrid_search.mjs

# Observation search tests
node test_observation_search.mjs
```

---

## ⚙️ Comparison with Original MCP Memory

| Dimension | Original | MemFS |
|-----------|----------|-------|
| **Observation Storage** | Embedded in entities | Centralized + ID reference |
| **Data Sharing** | Not supported | Hard-link style sharing |
| **Update Mechanism** | Direct overwrite | Copy-on-Write |
| **Search Capability** | Simple keyword | BM25 + Fuzzy |
| **Orphan Detection** |理论上不存在孤儿观察 | Supported |
| **Cache Mechanism** | None | 30s TTL |
| **Windows Compatibility** | Unknown | Graceful degradation |

---

## 📚 Design Philosophy

**What? You're still reading? Well, alright.**

Honestly, this project started because:

1. **LLM context is limited** — can't stuff all knowledge into prompts
2. **Filesystem is a great invention** — handling "multiple data sharing same content" is mature
3. **Humanities research has special needs** — concepts, literature, citation relationships
4. **Controllability > SOTA** — no need for black-box vector models

So:

- **Borrow filesystem wisdom**: inode table, hard links, copy-on-write
- **Search uses BM25 + Fuzzy**: lightweight, explainable, transparent, controllable
- **Expose as tools**: 16 MCP tools, LLM calls on demand

**Result?** — A quiet, efficient, unobtrusive knowledge management tool.

---

## 📄 Technical Documentation

📄 Want to learn more technical details? Check out these documents:

- [Technical Report](./docs/MemFS_TechnicalReport.md) - Overall architecture and design
- [Metadata & Time History](./docs/Metadata_of_time_history.md) - Timestamp evolution and IANA timezone handling
- [searchNode Technical Report](./docs/searchNode_TechnicalReport.md) - BM25 + Fuzzy hybrid search algorithm

---

## 📄 License

Apache License 2.0

---

**Manage knowledge the filesystem way—bringing order to chaos.**
