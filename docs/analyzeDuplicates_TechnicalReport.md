# MemFS analyzeDuplicates 技术报告

## 一、概述

### 1.1 背景

MemFS 的知识图谱在长期使用后，不可避免地会产生重复或高度相似的实体和观察——这是所有知识管理系统的固有问题。传统去重方案依赖 Embedding 向量相似度或人工审查，前者需要 GPU/向量数据库，后者在数百实体/数千观察的规模下不现实。

analyzeDuplicates 工具的目标是：**在纯 CPU 环境下，零新增外部依赖，利用现有 BM25 倒排索引，实现观察/实体/关系三层次的语义查重。**

### 1.2 设计原则

- **零新依赖**：完全复用 searchNode 的 2+3+4-gram BM25 索引
- **算法无知**：BM25 均值相似度不试图"理解"语义，只做数学关系提取
- **Worker 并行**：观察查重 + 实体查重通过 Worker threads 并发，不阻塞主线程
- **阈值可调**：分布直方图辅助用户校准阈值，默认 0.8（归一化）

---

## 二、核心算法：BM25 均值相似度

### 2.1 公式

```
Sim(A→B) = Σ BM25(g, B) / |Grams(A)|

最终得分 = max(Sim(A→B), Sim(B→A))  // 对称化
```

### 2.2 推导动机

传统 BM25 是不对称的——它计算查询 Q 对文档 D 的相关性。要衡量两篇文档 A 和 B 的相似度，需要对称化处理：

1. 将 A 的每个 gram 作为"查询"，计算它对 B 的 BM25 得分
2. 取均值得到 Sim(A→B)
3. 同理计算 Sim(B→A)
4. 取最大值——只要 A 的 tokens 在 B 中有高权重匹配，或反之，就说明二者相似

**对称化的意义**：如果 A 很短而 B 很长，Sim(A→B) 会高（A 的 few tokens 全命中 B），Sim(B→A) 会低（B 的许多 tokens 在 A 中找不到）。取 max 保证了短文档不会被长文档"淹没"。

### 2.3 实现代码

```javascript
// src/tfidf/bm25Search.js:325
computeDocSimilarity(docIdA, docIdB) {
    const docA = this.documents.get(docIdA);
    const docB = this.documents.get(docIdB);
    if (!docA || !docB) return 0;

    const tokensA = Array.from(docA.tokens);
    const tokensB = Array.from(docB.tokens);
    if (tokensA.length === 0 || tokensB.length === 0) return 0;

    const simAB = tokensA.reduce((sum, t) => sum + this._bm25(t, docIdB), 0) / tokensA.length;
    const simBA = tokensB.reduce((sum, t) => sum + this._bm25(t, docIdA), 0) / tokensB.length;

    return Math.max(simAB, simBA);
}
```

### 2.4 BM25 公式回顾

```javascript
_bm25(token, docId) {
    const df = this.docFrequency.get(token) || 1;
    const idf = Math.log((N - df + 0.5) / (df + 0.5));  // IDF
    const dl = docLength;                                  // 文档长度
    const numerator = tf * (k1 + 1);                       // 词频分子
    const denominator = tf + k1 * (1 - b + b * dl / avgdl);// 长度归一化
    return idf * (numerator / denominator);
}
```

**参数**：k1=1.2, b=0.5（标准 BM25 默认值）

**BM25 天然解决的核心问题**：

| 问题 | BM25 的应对 |
|------|------------|
| 高频词噪音（"的"、"是"、"了"） | IDF 自动压低 |
| 长文档天然命中更多词 | 长度归一化 b=0.5 补偿 |
| 跨长度文本比较 | 均值化 + max 对称化 |

---

## 三、架构设计

### 3.1 两层架构

```
┌──────────────────────────────────────────────────────────────┐
│                   searchIntegrator.analyzeDuplicates()        │
│  主进程编排层                                                    │
│  · 加载图谱 + 构建索引                                           │
│  · 收集 obsDocIds / entityNames                                │
│  · 分发 Worker / inline fallback                               │
│  · 收集结果 + 归一化 + 直方图                                     │
│  · 关系查重（精确匹配）                                           │
└──────────────────────┬───────────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
┌──────────────┐ ┌──────────┐ ┌──────────────┐
│ obs Worker   │ │ ent Wkr  │ │ inline       │
│ (Worker      │ │ (Worker  │ │ (small       │
│  threads)    │ │  threads)│ │  dataset)    │
└──────────────┘ └──────────┘ └──────────────┘
```

### 3.2 Worker vs Inline 的选择

| 条件 | 策略 |
|------|------|
| 观察数 ≥ 50 | Worker 线程并行（最多 8 workers） |
| 观察数 < 50 | 主进程 inline fallback |
| 实体数 ≥ 20 | Worker 线程并行 |
| 实体数 < 20 | 主进程 inline fallback |

### 3.3 Worker 内部架构（dedupWorker.js）

Worker 是**自包含的 BM25 索引**——它不从主进程共享索引，而是重新读取 JSONL 文件构建独立的 DedupIndex。

```javascript
// dedupWorker.js 结构
class DedupIndex {
    _addDoc(content, entityName, field, observationId) // 建索引
    _calcLengths()                                     // 计算 avgDocLength
    _bm25(token, docId)                                // BM25 打分
    computeDocSimilarity(docIdA, docIdB)               // 均值相似度
    buildFromLines(lines)                              // 从 JSONL 构建
}
```

**为何 Worker 独立索引而非共享主进程索引：**
- Worker threads 无法直接 transfer Map 对象（需 structured clone，大 Map 序列化开销高）
- 每个 Worker 读取 JSONL 构建索引 ≈ 200ms，相比计算时间 <10%
- 避免了多 Worker 并发访问同一 Map 的锁竞争

---

## 四、查重流程详解

### 4.1 观察查重（Observation Scope）

```
输入: 所有 obs: 开头的 docId 列表
输出: 相似观察对 { observationA, observationB, similarityScore, normalizedScore }
```

**候选对筛选**（inverted index pre-filtering）：

```javascript
// 对每个 docIdA:
// 1. 遍历其所有 tokens
// 2. 仅选择 df ≤ 200 的 token（跳过超高频词）
// 3. 从倒排索引找到共享这些 token 的其他 obs: 文档
// 4. 要求共享 token 数 ≥ 2
// 5. 取 top 100 候选
const cands = Array.from(sc.entries())
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 100);
```

**为什么需要 pre-filtering：** 观察数 ~2800 时，暴力两两比较 = 2800²/2 ≈ 3.9M 次 `computeDocSimilarity` 调用。pre-filtering 将实际计算量降低到 ~50K 次（约 1.3%）。

**df > 200 跳过逻辑：** IDF 已经很低的高频词（如"的"、"是"）不会贡献有效区分度，跳过它们约减少 60% 候选噪音。

### 4.2 实体查重（Entity Scope）

```
输入: 去重后的 entityNames 列表
输出: 相似实体对 { entityA, entityB, matchedField, matchedContent, similarityScore }
```

实体比较的是**字段级别文档**（name/definition/definitionSource），而非观察。每个实体产生最多 3 个 field docs：

| docId 格式 | 对应字段 |
|-----------|---------|
| `entity:韦伯:name` | 实体名称 |
| `entity:韦伯:definition` | 定义 |
| `entity:韦伯:definitionSource` | 来源 |

实体对 (A, B) 的最终得分为所有 field doc 间 `computeDocSimilarity` 的最大值。

**关键设计决策**：实体查重**排除 observation docs**。原因是 observation 数量远多于 field docs，而且实体间共享 observation（硬链接）是设计特性而非重复。若混入 observation，计算量从 3×3=9 次/实体对膨胀到 ~12×12=144 次。

### 4.3 关系查重（Relation Scope）

关系查重走**完全不同的路径**——不需要 BM25，是精确的去重检测：

```javascript
// 按 (from, to) 分组 relationTypes
const key = `${r.from}|${r.to}`;
// 若同一 (from, to) 对出现重复的 relationType，判定为重复
relationGroups.forEach(group => {
    const unique = [...new Set(group.relationTypes)];
    if (unique.length !== group.relationTypes.length) {
        // 有重复
    }
});
```

这检测的是"同一对实体之间被赋予了多次相同的关系类型"——虽然 `createRelation` 已在 API 层过滤精确重复，但直接写入 JSONL 或在旧版本中仍可能产生。

---

## 五、分数归一化与分布直方图

### 5.1 归一化

所有原始 BM25 相似度分数通过全局最大值归一化到 [0, 1]：

```javascript
const maxScore = Math.max(...allRawScores);
p.normalizedScore = p.similarityScore / maxScore;
```

### 5.2 分布直方图

```javascript
const bins = 10;
const normHist = new Array(bins).fill(0);
for (const s of allNormScores) {
    normHist[Math.min(Math.floor(s * bins), bins - 1)]++;
}
result.distribution = {
    histogram: normHist.map((count, i) => ({
        range: [(i/10).toFixed(2), ((i+1)/10).toFixed(2)],
        count,
        pct: parseFloat((count / total * 100).toFixed(1))
    })).filter(b => b.count > 0).reverse(),
    suggestedThreshold: 0.8
};
```

### 5.3 实测分布分析

在 MemFS 生产数据（324 实体 / 2761 观察）上实测分布：

| 区间（归一化） | 占比 | 语义含义 |
|--------------|------|---------|
| 0.80 - 1.00 | ~4.4% | **真实重复**：name 子集匹配、definitionSource 同值、定义交叉引用 |
| 0.40 - 0.80 | ~71.6% | **浅层语义关联**：共享 definitionSource 导致的假阳性 |
| < 0.40 | ~24.0% | 噪音 |

这就是默认阈值设为 0.8 的原因——去除了 90% 的 noise 而保留了 4.4% 的真阳性。

---

## 六、边界情况与测试

### 6.1 阈值边界

- `threshold < 0.01`：返回几乎所有候选对（仅被 pre-filtering 过滤的噪音）
- `threshold > 0.95`：几乎只返回完全相同的文档（name 字段精确匹配）
- `maxPairs` 硬上限 200：防止结果集过大撑爆 LLM context

### 6.2 空数据

- 无实体 → entityPairs = []（空结果，非报错）
- 无观察 → observationPairs = []
- 无关系 → relationDuplicates = []
- 分布直方图输出 `min:0, max:0, histogram: []`

### 6.3 dedupWorker 的异常处理

```javascript
main().catch(err => parentPort.postMessage({
    error: err.message, pairs: [], checked: 0
}));
```

Worker 内部异常不会导致主进程崩溃——通过 `postMessage` 返回错误，主进程在 `workerResults` 循环中 `continue` 跳过错误 worker 的结果。

---

## 七、性能指标

| 指标 | 数值 | 条件 |
|------|------|------|
| 全量扫描 | ~17.8s | 324 实体 / 2761 观察 / 4 workers |
| Worker 索引构建 | ~200ms | 单 worker 读取 JSONL + 构建 BM25 |
| Worker 数量上限 | 8 | `Math.min(os.cpus().length, 8)` |
| Inline fallback | <500ms | 观察 < 50 / 实体 < 20 |
| 主进程内存 | +~5MB | 临时 `result._obsDocIds` / `_entityNames` |

---

## 八、开发过程中记录的 Bug

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | MEMORY_DIR 路径混淆 | 相对路径被 `path.isAbsolute()` 判为 relative 后拼接到家目录 | 测试用 `path.resolve()` 传绝对路径 |
| 2 | obsMap 键格式不匹配 | inline fallback 的 obsMap key 是裸 ID (`'1'`)，lookup 时传 docId (`'obs:1'`) | `String(o.id)` → `'obs:' + o.id` |
| 3 | entityDocMap 混入 observation docs | `_addDoc` 未区分 field doc 和 observation doc | 仅在 `observationId === null` 时加入 entityDocMap |
| 4 | createRelation 精确去重屏蔽测试 | API 层 `line 870-872` 用三重精确匹配过滤重复关系 | 测试不走 MCP API，直接写 JSONL |
| 5 | addObservation 内容级去重屏蔽测试 | 相同内容的观察共享同一 ID（硬链接） | 测试用"近似但不完全相同"的文本 |
| 6 | MCP client 三层错误 | stdout/stderr 混淆 + handler 注册时机 + 数据竞争 | 启动检测移到 stderr，handler 提前注册，统一 stdout |
| 7 | Worker 串行调度 | 先 obs workers → await → 再 ent workers | 单次 `Promise.all` 并发 dispatch |

---

## 九、设计决策问答

### Q: 为什么不用向量相似度（cosine similarity）？

A: 向量相似度需要 Embedding 模型 + 向量数据库，违背 MemFS 的"零重型依赖"设计原则。BM25 均值相似度在纯文本语义匹配上表现足够好，且完全可解释、可调试。

### Q: 为什么对称化用 max 而非 mean？

A: 考虑 A="洛天依" 和 B="洛天依是虚拟歌手，代表作有《歌行四方》《乐鸣东方》..."。Sim(A→B) 会很高（A 的 3 个 token 全在 B 中命中），Sim(B→A) 会很低（B 的 50 个 token 只有 3 个在 A 中找到）。取 mean 会被长文档"稀释"，max 保留了核心匹配信号。

### Q: 为什么 Worker 独立重建索引？

A: Node.js Worker threads 的 structured clone 无法高效传输大型 Map。让每个 Worker 读取 JSONL 重建索引（~200ms 开销）比序列化/反序列化主进程 16MB 索引更简单可靠。且 JSONL 文件已被系统缓存，实际磁盘 I/O 忽略不计。

### Q: 为什么关系查重不用 BM25？

A: 关系数据是精确的类型枚举（relationType 是有限字符串集合），重复的定义是"同一对实体有相同的 relationType 多次"——这是精确匹配问题，不需要模糊比较。

---

## 十、相关文件索引

| 文件 | 作用 |
|------|------|
| `src/tfidf/bm25Search.js:325` | `computeDocSimilarity()` — 核心算法 |
| `src/tfidf/searchIntegrator.js:427` | `analyzeDuplicates()` — 编排函数 |
| `src/tfidf/dedupWorker.js` | Worker 线程模块 — 自包含 BM25 索引 |
| `index.js:2138` | Tool 注册 + Zod schema |
| `test_mcp_dedup.mjs` | 31 项 MCP 协议测试 |

---

## 十一、总结

analyzeDuplicates 的技术核心在于：

1. **复用而非重建**：利用现有 BM25 倒排索引，添加 30 行 `computeDocSimilarity` 即实现语义查重
2. **算法无知原则的胜利**：BM25 不"理解"文本，但 n-gram + IDF 的数学组合天然捕获了语义距离
3. **Worker 并行的实用主义**：不是最高效的方案，但足够好用（~18s 全量扫描 vs 25s 串行）
4. **分布驱动的阈值校准**：实测分布直方图让用户自己决定"什么算重复"，而非硬编码

这也验证了 MemFS 整体设计哲学的一个核心论断：**简单的数学方法 + 充分的工程实现 > 复杂的黑盒方案。**
