# MemFS 2.4.12 更新详情

---

## 一、版本信息

| 项目 | 内容 |
|------|------|
| 起始版本 | 2.4.12 (ec8a260) |
| 最新版本 | 2.4.12 (344414a) |
| 提交总数 | 21 个 |

---

## 二、提交列表

| # | Commit | 消息 |
|---|--------|------|
| 1 | 71b51a7 | refactor(search): unify tokenization with gram penalty following bitter lesson |
| 2 | 6c85532 | fix(search): preserve arithmetic operators +-*/ in cleanText |
| 3 | c9d436c | feat: add debug_search.html web UI for searchNode debugging |
| 4 | c257c32 | refactor(searchNode): remove searchMode, add updatedAt to observations |
| 5 | 14d4465 | fix(searchNode): limit total entities including related entities |
| 6 | 6fd5860 | fix(searchNode): fix parameter limits for entities, observations, relations |
| 7 | 4132d6c | feat(search): add definitionSource to index, adjust field weights, enhance relation matching |
| 8 | b473c76 | refactor(search): make fieldWeights single source of truth in HybridSearchService |
| 9 | 46ab90f | fix(search): use gram tokens for relation matching |
| 10 | 158cd2a | docs: update AGENTS.md with search architecture and recent changes |
| 11 | 2714035 | docs: update searchNode technical report to reflect current implementation |
| 12 | f17818c | fix(search): apply 2-gram penalty to reduce false positive matches |
| 13 | 0948b19 | docs: update AGENTS.md with 2-gram penalty fix |
| 14 | 1a5ff02 | fix(console): deduplicate console buffer messages |
| 15 | c87f69b | fix(console): trim messages before deduplication |
| 16 | caaf7b7 | refactor: simplify write operation return messages |
| 17 | b279ceb | fix: addObservation outputSchema missing addedObservationIds field |
| 18 | 99329b8 | fix: deleteEntity outputSchema declares full entity JSON structure |
| 19 | c6ca7d1 | refactor(deleteObservation): input by ID, output includes original content |
| 20 | e01619b | docs(recycleObservation): clarify output includes original content for undo |
| 21 | 344414a | fix(deleteEntity): remove strict type literal in outputSchema |

---

## 三、功能更新分类

### 1. Git Auto-Commit (ec8a260)

**环境变量：** `GITAUTOCOMMIT=true`

**核心功能：**
- 每次 `saveGraph()` 自动提交到 Git
- 提交格式：`auto-commit:[operationContext] at [utc:YYYY-MM-DDTHH:mm:ss.SSSZ] [tz:Asia/Shanghai]`
- 实体名称用双引号包裹，多个实体用逗号分隔

**Git Author 配置：**
- `user.name`: `memfs-{version}` (例如 `memfs-2.4.12`)
- `user.email`: `username-memfs@hostname` (例如 `qtgcy-memfs@DESKTOP-XXX`)

**getConsole 工具输出格式：**
- 包含 author 和 email：`%h %an <%ae> %s`

**新增文件：**
- `gitSync` 模块 (~200 行)
- `getConsole` 工具
- `test_gitsync.mjs`
- `test_mcp_full.mjs`

**MEMORY_FILE_PATH 弃用警告**

---

### 2. searchNode 重构 (71b51a7 ~ f17818c)

**统一分词系统**
- 移除 `isChineseText()` 语言检测
- 新增 `cleanText()` 统一清洗
- 统一 2~(n-1) gram 体系

**2-gram 惩罚**
```javascript
function getGramPenalty(n) {
    if (n === 2) return 0.5;  // ×0.5 惩罚
    return 1 / Math.pow(Math.E, n - 2);
}
```

**字段权重调整**

| 字段 | 旧权重 | 新权重 |
|------|--------|--------|
| name | 5.0 | 5.0 |
| entityType | 4.0 | 2.5 |
| definition | 4.0 | 2.5 |
| definitionSource | - | 1.5 |
| observation | 3.0 | 1.0 |

**其他优化**
- `definitionSource` 加入搜索索引
- 关系类型匹配 boost (1.5x)
- `searchMode` 移除
- `updatedAt` 字段加入 observations
- 关联实体总数受 `limit` 限制

---

### 3. Console 去重 (1a5ff02, c87f69b)

**新增 `getConsole` 工具**
- 获取缓冲日志
- 消息去重 (Set)
- trim 后去重

---

### 4. 操作返回重构 (caaf7b7, c6ca7d1)

**返回简化**
| 操作 | text 返回 |
|------|----------|
| createEntity | `Created N entities: [names]` |
| createRelation | `Created N relations` |
| addObservation | `Added observations to N entities, new obs IDs: [ids]` |
| updateNode | `Updated N entities: [names]` |
| updateObservation | `Updated observations: [ids]` |
| deleteEntity | `Deleted entities: [names]` |
| deleteObservation | `Unlinked observations: [ids]` |

**deleteObservation 重构**
- 输入从 content 改为 ID
- 输出包含 `originalContent` 和 `observationData`

**deleteEntity 输出**
- 返回完整 `deletedEntities` 和 `deletedRelations` 便于撤销

---

### 5. Schema 修复 (b279ceb, 99329b8, 344414a)

- `addObservation` 增加 `addedObservationIds` 字段
- `deleteEntity` schema 声明完整结构
- 移除严格的 `z.literal("entity")` 类型要求

---

### 6. N-gram Token 爆炸修复

**问题**：错误的 2~(n-1) gram 实现导致短文本产生 O(n²) tokens
- 44 字符文本 → 1875 tokens
- 448K 文件 → 2.5M unique tokens → 1GB+ 内存

**修复**：增量 n-gram 方案
```javascript
// n=3: 2-gram | n=4: 2-gram+3-gram | n≥5: 2-gram+3-gram+4-gram
```

**效果**：
- 内存：1GB+ → 20MB
- 索引时间：3.3s → 90ms

---

### 7. 其他更新

**文档更新**
- `AGENTS.md`
- `docs/searchNode_TechnicalReport.md`

---

## 四、代码改动统计

| 分类 | 文件 | 改动量 |
|------|------|--------|
| Search 重构 | `src/tfidf/*.js` | ~600 行 |
| Console 修复 | `index.js` | ~150 行 |
| 返回简化 | `index.js` | ~100 行 |
| Schema 修复 | `index.js` | ~80 行 |
| 调试工具 | `debug_search.html` | +926 行 |
| 文档更新 | `AGENTS.md`, `docs/*.md` | ~300 行 |

---

## 五、详细代码改动

### ec8a260 - Git Auto-Commit 功能引入

```javascript
// 新增 gitSync 对象
const gitSync = {
    enabled: false,
    initialized: false,
    memoryDir: null,
    
    isEnabled() {
        const gitsync = process.env.GITAUTOCOMMIT;
        this.enabled = (gitsync === 'true' || gitsync === '1' || gitsync?.toLowerCase() === 'yes');
        return this.enabled;
    },
    
    async initRepo(dir) { ... },
    async autoCommit(memoryFilePath, operationContext) { ... }
};

// 新增 getConsole 工具
server.registerTool("getConsole", {
    title: "Get Console",
    inputSchema: {},
    outputSchema: {}
}, async () => {
    return {
        content: [{ type: "text", text: lines.join('\n') }],
        structuredContent: {}
    };
});

// saveGraph 中调用
await gitSync.autoCommit(this.memoryFilePath, this.lastOperation);
```

---

### 71b51a7 - 统一分词系统

```javascript
// 移除 isChineseText，新增 cleanText
function cleanText(text) {
    return text
        .replace(/[\u3000-\u303f\uff00-\uffef!@#$%^&*()_+\-=\[\]{}|;':",.\/<>?`~\\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// 统一 2~(n-1) gram
for (let n = 2; n <= cleaned.length - 1; n++) {
    generateNGram(cleaned, n).forEach(t => tokens.add(t));
}

// 新增 getGramPenalty
function getGramPenalty(n) {
    return 1 / Math.pow(Math.E, n - 2);
}
```

---

### f17818c - 2-gram 假阳性修复

```javascript
// 2-gram 惩罚
function getGramPenalty(n) {
    if (n === 2) return 0.5;  // ×0.5 惩罚
    return 1 / Math.pow(Math.E, n - 2);
}

// BM25 支持预计算 tokens 和惩罚
search(query, options = {}) {
    const { tokens: providedTokens, tokenPenalties } = options;
    // 应用惩罚
    queryTokens.forEach((token, index) => {
        const penalty = tokenPenalties[index] || 1.0;
        docScore += this._bm25(token, docId) * penalty;
    });
}

// fullQuery + name 匹配 boost 5x → 10x
if (nameMatched) weightMultiplier = 10.0;
```

---

### caaf7b7 - 写操作返回简化

```javascript
// 简化前
content: [{ type: "text", text: JSON.stringify(result, null, 2) }]

// 简化后
content: [{ type: "text", text: `Created ${result.length} relations` }]

// deleteEntity 返回完整数据
return {
    deletedEntities,
    deletedRelations
};
```

---

### c6ca7d1 - deleteObservation 重构

```javascript
// 输入从 content 改为 ID
async deleteObservation(observationIds, entityNames) {
    const obs = graph.observations.find(o => o.id === obsId);
    results.push({
        observationId: obs.id,
        originalContent: obs.content,  // 新增
        observationData: { id, content, createdAt, updatedAt }  // 新增
    });
}
```

---

## 六、版本更新记录

| 版本 | Commit | 主要更新 |
|------|--------|----------|
| 2.4.12 | ec8a260 | Git Auto-Commit 功能引入 |
| 2.4.12 | 71b51a7 ~ f17818c | searchNode 重构、分词系统、2-gram 惩罚 |
| 2.4.12 | 1a5ff02, c87f69b | Console 去重、新增 getConsole |
| 2.4.12 | caaf7b7, c6ca7d1 | 操作返回简化、deleteObservation 重构 |
| 2.4.12 | b279ceb, 99329b8, 344414a | Schema 修复 |
