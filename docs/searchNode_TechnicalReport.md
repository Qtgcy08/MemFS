# MemFS searchNode 技术报告

## 一、概述

### 1.1 项目背景

MemFS 是一个基于 MCP Memory Server 深度重构的知识图谱管理系统，其核心设计理念是将现代文件系统的概念迁移到知识图谱管理中。在文件系统中，搜索和检索是核心功能之一；在知识图谱中，高效、准确的实体检索同样至关重要。本报告详细阐述 MemFS 中 `searchNode` 工具的技术实现方案，包括其架构设计、算法选择、参数配置以及优化策略。

>「 本搜索模块的设计遵循 MemFS 的整体哲学。关于整体设计思想，请参阅《MemFS 整体技术报告》。」

MemFS 引入了基于 BM25（Best Matching 25）和模糊搜索的混合检索方案。

### 1.2 设计目标

本技术方案的设计目标包含以下几个方面：

**检索准确性**：通过 BM25 算法计算查询词与文档的相关性，能够识别出真正重要的词汇，而不是简单地将包含查询词的文档全部返回。BM25 考虑了词频（term frequency）和逆文档频率（inverse document frequency）两个维度，能够有效区分常见词汇和专业术语。

**模糊匹配能力**：引入 Fuse.js 提供模糊搜索功能，能够容忍用户输入的拼写错误、拼写变体以及格式差异。这对于知识图谱应用尤为重要，因为用户可能并不确切记得实体名称的正确拼写，或者在输入过程中容易产生笔误。

**分词质量**：采用基于 n-gram 的智能分词方案，能够正确处理中英文混合内容，避免误匹配，且不依赖词库。

**零依赖设计**：放弃对外部库的依赖，改用纯 JavaScript 实现的 n-gram + BM25，减少外部依赖。

**结果排序优化**：将 BM25 和模糊搜索的结果进行加权融合，同时考虑命中的字段类型（如实体名称的权重高于观察内容的权重），最终按照综合相关性得分对结果进行排序。

**向后兼容**：保留传统的关键词匹配模式作为备选方案，用户可以通过 `basicFetch=true` 参数显式选择使用传统搜索，这在某些特殊场景下（如已知确切实体名称时的快速检索）可能更为高效。

**可控返回量**：设置合理的默认返回数量上限（15个），避免一次返回过多结果导致LLM上下文溢出，同时确保用户能够获取足够数量的相关实体。

**《苦涩的教训》原则**：不使用语言学知识，让通用计算方法（n-gram + BM25）解决问题。

### 1.3 技术选型

**纯 JavaScript BM25**：零依赖，对中文友好，不依赖外部 NLP 库。

**Fuse.js 7.1.0**：轻量级模糊搜索库，支持自定义权重和阈值。

**ES Modules**：所有搜索模块使用 `import`/`export` 语法。

## 二、架构设计

### 2.1 模块结构

```
src/tfidf/
├── searchIntegrator.js         # 集成层，搜索入口
├── hybridSearchService.js      # 混合搜索核心（权重配置中心）
├── bm25Search.js               # BM25 搜索实现
├── fuseSearch.js               # 模糊搜索实现
└── traditionalSearch.js        # 传统搜索（向后兼容）
```

### 2.2 数据流设计

```
用户请求 (query, options)
    │
    ▼
searchIntegrator.searchNode()
    │
    ├── basicFetch=true ──→ TraditionalSearcher.search() ──→ 返回结果
    │
    └── basicFetch=false ──→ HybridSearchService.search()
                                │
                                ├── 1. cleanText() 清洗查询
                                ├── 2. tokenizeQuery() 生成 gram tokens
                                ├── 3. BM25 搜索 (topK=50)
                                ├── 4. 模糊搜索 (topK=50)
                                ├── 5. 结果聚合
                                ├── 6. 加权融合 + boost
                                └── 7. 过滤与限幅
```

## 三、查询处理

### 3.1 清洗文本

查询首先经过 `cleanText()` 清洗，统一匹配基础：

```javascript
function cleanText(text) {
    return text
        .replace(/[\u3000-\u303f\uff00-\uffef!@#$%^&*()=\[\]{}|;':",.\/<>?`~\\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
```

**保留的计算符号**：`+-*/` 不被移除，以支持公式类查询。

### 3.2 统一切词机制

遵循《苦涩的教训》：不区分语言，使用增量 n-gram 方案避免 O(n²) 爆炸。

```javascript
function tokenizeQuery(query) {
    const cleaned = cleanText(query);
    const tokens = new Set();
    const fullQuery = cleaned;

    if (fullQuery.length >= 2) {
        tokens.add(fullQuery);  // 全词兜底
    }

    const whitespaceTokens = cleaned.split(/\s+/);

    whitespaceTokens.forEach(token => {
        if (token === fullQuery) return;
        tokens.add(token);

        // 增量 n-gram：避免短文本产生海量 tokens
        // n=3: 2-gram | n=4: 2-gram+3-gram | n≥5: 2-gram+3-gram+4-gram
        if (token.length >= 3) generateNGram(token, 2).forEach(g => tokens.add(g));
        if (token.length >= 4) generateNGram(token, 3).forEach(g => tokens.add(g));
        if (token.length >= 5) generateNGram(token, 4).forEach(g => tokens.add(g));
    });

    return { tokens, fullQuery, tokenPenalties };
}
```

### 3.3 Gram 惩罚机制

**2-gram 特殊惩罚**：短 bigram 如 "CA" 可能产生假阳性（如 "Technical" 中的 "CA" 匹配 "CACG+" 中的 "CA"），因此 2-gram 单独设置 ×0.5 惩罚。

长 gram 使用指数衰减：

```javascript
function getGramPenalty(n) {
    if (n === 2) return 0.5;  // ×0.5 惩罚，减少假阳性
    return 1 / Math.pow(Math.E, n - 2);
}
```

| n | penalty | 含义 |
|---|---------|------|
| 2 | **0.5** | 假阳性惩罚 |
| 3 | 0.368 | 约 1/3 |
| 4 | 0.135 | 约 1/7 |
| 5 | 0.050 | 约 1/20 |

### 3.4 分词示例

**查询**: `"明日方舟终末地 新中国风"`

```
清洗后: "明日方舟终末地新中国风"
分词: ["明日方舟终末地新中国风", "明日方舟终末地", "新中国风", 
       "明日方", "日方舟", ..., "新中国", "中国风", ...]

各 token 的 penalty 由长度决定
```

## 四、BM25 搜索实现

### 4.1 字段权重（单一数据源）

字段权重定义在 `hybridSearchService.js` 的 `DEFAULT_FIELD_WEIGHTS`：

```javascript
const DEFAULT_FIELD_WEIGHTS = {
    'name': 5.0,
    'entityType': 2.5,
    'definition': 2.5,
    'definitionSource': 1.5,
    'observation': 1.0
};
```

该权重同时传递给 BM25 和 Fuse.js，确保两个搜索引擎使用相同的权重配置。

### 4.2 索引构建

BM25 索引为每个字段独立建索引：

```javascript
buildIndex(entities, observations) {
    // 索引实体名称
    entities.forEach(entity => {
        this._addDocument(entity.name, entity.name, 'name', entity);
    });

    // 索引实体类型
    entities.forEach(entity => {
        if (entity.entityType) {
            this._addDocument(entity.entityType, entity.name, 'entityType', entity);
        }
    });

    // 索引定义
    entities.forEach(entity => {
        if (entity.definition) {
            this._addDocument(entity.definition, entity.name, 'definition', entity);
        }
    });

    // 索引定义来源 (新增)
    entities.forEach(entity => {
        if (entity.definitionSource) {
            this._addDocument(entity.definitionSource, entity.name, 'definitionSource', entity);
        }
    });

    // 索引观察内容
    entities.forEach(entity => {
        (entity.observationIds || []).forEach(obsId => {
            const content = obsContentMap.get(obsId);
            if (content) {
                this._addDocument(content, entity.name, 'observation', entity, obsId);
            }
        });
    });
}
```

### 4.3 BM25 得分计算

```javascript
_bm25(token, docId) {
    const f = doc.tokens.has(token) ? 1 : 0;  // TF
    const df = this.docFrequency.get(token) || 1;
    const idf = Math.log((this.totalDocs - df + 0.5) / (df + 0.5));
    const docLength = this.docLengths.get(docId) || 1;
    const numerator = f * (BM25_K1 + 1);
    const denominator = f + BM25_K1 * (1 - BM25_B + (BM25_B * docLength / this.avgDocLength));
    return idf * (numerator / denominator);
}
```

**参数**：k1=1.2, b=0.5

## 五、模糊搜索实现

### 5.1 Fuse.js 配置

```javascript
this.options = {
    includeScore: true,
    threshold: 0.1,  // 严格模式
    keys: Object.entries(DEFAULT_FIELD_WEIGHTS).map(([name, weight]) => ({
        name,
        weight
    }))
};
```

Fuse.js 的 keys 配置继承自 `DEFAULT_FIELD_WEIGHTS`，与 BM25 使用相同的字段权重。

### 5.2 得分转换

Fuse.js 使用相似度得分（越小越好），需要取反转换为相关性得分：

```javascript
const invertedScore = 1 - r.score;  // 取反
```

## 六、结果聚合与融合

### 6.1 Boost 机制

| 匹配类型 | Boost 倍数 | 说明 |
|---------|-----------|------|
| **fullQuery + name** | **10×** | 5× base + 2× fusion → 最高优先级 |
| **fullQuery + 其他字段** | **3×** | 2× base + 1.5× fusion |
| **普通匹配** | 1× | 仅靠 gram penalty |
| **多 term 命中** | × log₂(1+k) | applyFusion termBoost |
| **Relation 类型匹配** | **1.5×** | 关系类型包含 query gram tokens |

### 6.2 Gram 惩罚应用

在 `addEntityScore()` 中，惩罚与 boost 共同生效：

```javascript
const weightedScore = normalizedScore * weightMultiplier * penalty;
```

### 6.3 Relation Boost

当关系类型匹配查询 gram tokens 时，获得额外 boost：

```javascript
const queryTerms = result.terms;  // 使用 gram tokens

graph.relations.forEach(r => {
    const relationTypeLower = r.relationType.toLowerCase();
    const relationMatchesQuery = queryTerms.some(term => 
        relationTypeLower.includes(term.toLowerCase())
    );
    const scoreBoost = relationMatchesQuery ? 1.5 : 0.5;
    // ...
});
```

## 七、参数与限制

### 7.1 可配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `query` | 必填 | 搜索查询字符串 |
| `time` | false | 是否包含观察内容的时间戳 |
| `basicFetch` | false | 是否使用传统关键词搜索 |
| `limit` | 15 | 最大返回实体数量 |
| `maxObservationsPerEntity` | 5 | 每个实体最多返回的观察数量 |
| `bm25Weight` | 0.7 | BM25 搜索的权重系数 |
| `fuzzyWeight` | 0.3 | 模糊搜索的权重系数 |
| `minScore` | 0.01 | 最小相关性得分阈值 |

### 7.2 数量限制

| 类型 | 限制规则 |
|------|----------|
| **entities** | ≤ `limit`（直接匹配 + 关联实体） |
| **observations** | ≤ `limit × maxObservationsPerEntity` |
| **relations** | ≤ `limit × 2` |

## 八、输出格式

### 8.1 响应结构

```javascript
{
    entities: [
        {
            name: string,
            entityType: string,
            definition: string,
            definitionSource: string | null,
            observationIds: number[]
        }
    ],
    relations: [
        {
            from: string,
            to: string,
            relationType: string
        }
    ],
    observations: [
        {
            id: number,
            content: string,
            createdAt: string | null,  // time=true 时
            updatedAt: string | null   // time=true 时
        }
    ]
}
```

### 8.2 内部调试信息

混合搜索模式 (`basicFetch=false`) 的 `_meta`:

```javascript
_meta: {
    query: string,                   // 原始查询字符串
    fullQuery: string,               // 清洗后的完整查询
    terms: string[],                 // gram tokens
    totalCandidates: number,         // 候选实体总数
    returnedCount: number,           // 返回的直接匹配实体数
    relatedEntitiesCount: number,    // 关联实体数（通过关系连接）
    bm25Weight: number,              // BM25 权重（默认 0.7）
    fuzzyWeight: number,             // 模糊搜索权重（默认 0.3）
    minScore: number,                // 实际使用的最小得分阈值
    limit: number,                   // 最大返回实体数
    indexStatus: 'ready' | 'rebuilding',  // 索引状态
    rebuildScheduled: boolean,       // 是否有重建任务待处理
    timestamp: string,               // 搜索执行时间
    tokenization: [{                 // 每 token 的搜索统计
        term: string,
        isFullQuery: boolean,
        tfidfCount: number,
        fuseCount: number
    }]
}
```

传统搜索模式 (`basicFetch=true`) 的 `_meta`:

```javascript
_meta: {
    searchMode: 'traditional',       // 标识当前模式
    totalCandidates: number,
    returnedCount: number,
    relatedEntitiesCount: number,
    bm25Weight: number,
    fuzzyWeight: number,
    timestamp: string
}
```

## 九、向后兼容

### 9.1 传统搜索模式

当 `basicFetch=true` 时，使用关键词包含匹配：

```javascript
const keywords = query.split(/\s+/).filter(k => k.length >= 2);

if (keywords.some(kw => entity.name.toLowerCase().includes(kw.toLowerCase()))) {
    isRelevant = true;
}
```

## 十、最近更新 (2026-03)

### 10.1 Gram Tokenization

- 移除语言检测 (`isChineseText`)
- **增量 n-gram 方案**：n≤2 全词、n=3 全词+2-gram、n=4 全词+2-gram+3-gram、n≥5 全词+2-gram+3-gram+4-gram
- 添加 `cleanText()` 去除符号
- **性能优化**：避免 O(n²) token 爆炸，索引内存从 ~1GB 降至 ~20MB（448K 文件）

### 10.2 Gram Penalty

- 新增 `getGramPenalty(n)` = 1/e^(n-2)
- **2-gram 特殊处理**：×0.5 惩罚，减少假阳性（如 "CA" 匹配 "Technical" 中的 "CA" 与 "CACG+" 中的 "CA"）
- 长 gram 自动降权

### 10.3 Field Weights

| 字段 | 旧权重 | 新权重 |
|------|--------|--------|
| name | 5.0 | 5.0 |
| entityType | 4.0 | 2.5 |
| definition | 4.0 | 2.5 |
| definitionSource | - | 1.5 |
| observation | 3.0 | **1.0** |

- 集中定义在 `DEFAULT_FIELD_WEIGHTS`

### 10.4 Relation Boost

- 关系类型匹配查询 gram tokens → **1.5× boost**
- 使用 gram tokens 而非 fullQuery 进行匹配
- 关联实体加权参与排序

### 10.5 Limit 修复

- entities: 限制为 `limit`（含关联实体）
- relations: 限制为 `limit × 2`
- observations: 限制为 `limit × maxObservationsPerEntity`

### 10.6 输出格式

- 移除 `searchMode` 字段
- observations 新增 `updatedAt` 字段

## 十一、性能指标

| 指标 | 表现 |
|------|------|
| 索引建立（448K 文件） | ~90ms / ~20MB 内存 |
| 单次查询延迟 | <20ms |
| 内存占用 | <50MB（索引优化后） |
| 离线使用 | 支持 |

## 十二、总结

`searchNode` 采用 **n-gram + BM25 + Fuse.js** 三层混合架构：

```
查询 → cleanText() → tokenizeQuery() → BM25(0.7) + Fuse(0.3) → 融合 → 排序
                                  ↓
                          gram tokens + penalty
                          field weights
                          fullQuery boost
                          relation boost
```

**设计理念**：《苦涩的教训》——不使用语言学知识，让通用方法（计算）解决问题。
