# 时间元数据演进文档

> **核心观点**：时间和地点是知识轨迹不可分割的组成部分。记录「何时何地」获取或更新知识，对于人文社科研究具有重要的方法论意义。

---

## 一、背景与动机

### 1.1 为什么时间元数据如此重要

在知识管理系统中，时间戳不仅仅是「何时创建」的标记，更承载着丰富的语义信息：

- **研究情境还原**：研究者在北京、东京还是纽约阅读同一篇文献，可能反映不同的研究视角和学术传统
- **知识演化追踪**：一个概念从初次接触到深化理解，往往跨越数月甚至数年，时间线揭示认知演变轨迹
- **协作与引用验证**：当多人协作时，时间戳帮助厘清知识贡献的时间顺序
- **研究方法论反思**：时区信息可以揭示研究者的地理分布和跨文化知识流动模式
  
此外，相比通过GNSS获取地理位置受硬件和室内环境的限制，系统时区提供了一种低成本且易于获取的空间信息

### 1.2 人文社科研究的特殊需求

与理工科不同，人文社科研究具有显著的时间敏感性和地域依赖性：

| 研究特征     | 时间元数据的意义        |
| -------- | --------------- |
| 文献阅读的渐进性 | 记录首次接触与反复研读的时间差 |
| 跨文化比较    | 区分不同地区的知识来源     |
| 思想史梳理    | 构建概念传入与传播的时间线   |
| 个人知识管理   | 建立学习历程的可视化档案    |

---

## 二、演进历程

### 2.1 阶段一：UTC ISO 8601

```jsonl
{"type":"observation","id":1,"content":"研究笔记","createdAt":"2026-02-08T08:18:30.317Z"}
```

**问题**：

- 无具体时区信息，无法区分不同时区
- 无法区分创建时间和修改时间
- 返回UTC时间容易导致LLM产生误解

### 2.2 阶段二： 本地时间+偏移

```jsonl
{"type":"observation","id":2,"content":"另一条笔记","createdAt":"2026-02-09 07:14:05+0800"}
```

**改进**：

- 引入了 ISO 8601 标准时间格式
- 本地时间带偏移量（如 `+0800`）

**问题**：

- `+0800` 存在歧义：可能是中国内地、中国香港、新加坡等多个地区
- UTC 和本地时间混用，解析逻辑复杂
- 偏移量格式与 ISO 标准不完全一致（ISO标准为UTC时间+偏移量）

### 2.3 阶段三：完整时间元数据结构（当前实现）

```jsonl
{"type":"observation","id":1,"content":"研究笔记","createdAt":{"utc":"2026-02-08T13:53:07Z","timezone":"Asia/Shanghai"},"updatedAt":{"utc":"2026-02-09T15:30:00Z","timezone":"Asia/Shanghai"}}
```

**核心设计**：

- **UTC 时间**：精确的绝对时间参照，用于时间比对和排序
- **IANA 时区**：精确的地理位置标识，区分同一偏移量下的不同地区
- **updatedAt 字段**：支持知识演化的全生命周期追踪

---

## 三、设计决策与思考

### 3.1 为什么选择 IANA 时区而非偏移量

**决策**：使用 `Asia/Shanghai` 而非 `+0800`

**理由**：

1. **精确性**：`Asia/Shanghai` 明确指向中国内地，而 `+0800` 可能代表中国内地、中国香港、新加坡、吉隆坡等多个地区

2. **语义丰富性**：时区名称包含地理和文化信息。时区信息记录了用户添加观察的位置，同时不同地区的学术传统和研究视角可能不同

3. **夏令时处理**：IANA 时区数据库自动处理夏令时变更，而固定偏移量无法适应这一变化

```javascript
// ✅ 推荐的存储格式
{
    "utc": "2026-02-09T14:02:06Z",
    "timezone": "Asia/Shanghai"
}

// ❌ 不推荐的格式（歧义）
{
    "createdAt": "2026-02-09 22:02:06+0800"
}
```

### 3.2 为什么同时保留 UTC 和返回本地格式化时间

**决策**：存储同时包含 UTC 和 IANA 时区，API 返回本地格式化时间

**理由**：

| 维度   | UTC       | 本地时间（带时区） |
| ---- | --------- | --------- |
| 精确性  | ✅ 绝对精确    | ✅ 可还原     |
| 可比性  | ✅ 跨时区直接比对 | ❌ 需转换     |
| 可读性  | ❌ 专业用户友好  | ✅ 普通用户友好  |
| 语义完整 | ✅ 绝对时间点   | ✅ 情境信息    |

**设计原则**：

- **持久化**：UTC + IANA 时区双记录，兼顾精确性与语义完整性
- **API 层**：返回本地时间 + IANA 时区标识，兼顾可读性与准确性

### 3.3 为什么引入 updatedAt 字段

**决策**：在 Copy-on-Write 机制中同时记录 createdAt 和 updatedAt

**理由**：

1. **知识演化追踪**：区分「最初获取」和「最后更新」两个关键时间点

2. **版本历史**：支持后续扩展为完整的版本控制系统

3. **协作场景**：多用户编辑时，updatedAt 帮助识别最新贡献

```javascript
// 新观察（首次创建）
{
    "utc": "2026-02-08T13:53:07Z",
    "timezone": "Asia/Shanghai"
}

// 已有观察（Copy-on-Write 更新后）
{
    "utc": "2026-02-08T13:53:07Z",           // 创建时间（继承）
    "timezone": "Asia/Shanghai",
    "updatedAt": {
        "utc": "2026-02-09T15:30:00Z",      // 更新时间（新创建）
        "timezone": "Asia/Shanghai"
    }
}
```

### 3.4 为什么要明确区分 createdAt 和 updatedAt

**决策**：API 返回的时间值需要标注其类型（`createdAt` 或 `updatedAt`）

**实现**：`formatTimestamp` 函数返回 `{ value, type }` 结构

```javascript
// formatTimestamp 返回值示例
formatTimestamp({utc, timezone, updatedAt})
// → { value: "2026-02-09 22:02:06 Asia/Shanghai", type: "updatedAt" }

formatTimestamp({utc, timezone})
// → { value: "2026-02-09 22:02:06 Asia/Shanghai", type: "createdAt" }
```

**理由**：

1. **语义清晰**：LLM明确知道当前值是创建时间还是更新时间
2. **混合格式处理**：当 createdAt 使用旧格式字符串而 updatedAt 使用新格式对象时，仍能正确区分

### 3.5 为什么保持向后兼容

**决策**：支持三种时间格式的读取

| 格式      | 示例                           | 处理方式       |
| ------- | ---------------------------- | ---------- |
| UTC ISO | `"2026-02-08T08:18:30.317Z"` | 直接返回       |
| 本地+偏移   | `"2026-02-09 07:14:05+0800"` | 直接返回（不做解析） |
| 新格式对象   | `{utc, timezone}`            | 转换为本地时间返回  |

**理由**：

1. **渐进式迁移**：允许现有数据逐步升级，而非强制一次性迁移
2. **降低风险**：避免大规模数据转换可能引入的错误
3. **用户友好**：旧数据不会被破坏，用户可按自己的节奏更新

---

## 四、技术实现

### 4.1 核心函数

| 函数                             | 用途           | 返回值                              |
| ------------------------------ | ------------ | -------------------------------- |
| `getSystemTimezone()`          | 获取系统 IANA 时区 | `"Asia/Shanghai"`                |
| `getCurrentTimestamp()`        | 创建存储用时间戳     | `{utc, timezone}`                |
| `formatWithTimezone()`         | UTC 转换为本地时间  | `"YYYY-MM-DD HH:mm:ss Timezone"` |
| `formatTimestamp()`            | API 时间格式化    | `{value, type}`                  |
| `formatObservationTimestamp()` | 观察时间格式化      | `{createdAt, updatedAt}`         |

### 4.2 代码示例

```javascript
// 获取系统时区
function getSystemTimezone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// 创建时间戳（存储用）
function getCurrentTimestamp() {
    return {
        utc: new Date().toISOString(),
        timezone: getSystemTimezone()
    };
}

// 格式化时间（API 返回）
function formatTimestamp(data) {
    if (!data) return null;

    if (typeof data === 'object' && data.utc) {
        // 优先返回 updatedAt
        if (data.updatedAt) {
            const updatedAt = data.updatedAt;
            if (typeof updatedAt === 'object' && updatedAt.utc) {
                return {
                    value: formatWithTimezone(updatedAt.utc, updatedAt.timezone || data.timezone),
                    type: 'updatedAt'
                };
            }
        }
        // 返回 createdAt
        return {
            value: formatWithTimezone(data.utc, data.timezone),
            type: 'createdAt'
        };
    }

    // 旧格式直接返回
    if (typeof data === 'string') {
        return { value: data, type: 'createdAt' };
    }

    return null;
}
```

### 4.3 时间格式对比表

| 场景            | 输入格式                         | 输出格式                                                |
| ------------- | ---------------------------- | --------------------------------------------------- |
| 新观察创建         | `getCurrentTimestamp()`      | `{utc, timezone}`                                   |
| Copy-on-Write | 旧观察 + 新内容                    | `{utc, timezone, updatedAt: {utc, timezone}}`       |
| API 响应（新格式）   | `{utc, timezone}`            | `"2026-02-09 22:02:06 Asia/Shanghai"`               |
| API 响应（有更新）   | `{utc, timezone, updatedAt}` | `"2026-02-09 22:02:06 Asia/Shanghai"`（返回 updatedAt） |
| API 响应（旧格式）   | `"2026-02-08T08:18:30.317Z"` | `"2026-02-08T08:18:30.317Z"`                        |

---

## 五、未来展望

### 5.1 可扩展功能

1. **完整版本历史**：记录每次修改的完整快照
2. **时区感知搜索**：支持按时间范围筛选时区
3. **知识流动分析**：分析跨时区的知识引用模式

### 5.2 潜在挑战

1. **性能考虑**：完整版本历史可能带来存储压力
2. **数据迁移**：现有数据的渐进式升级需要清晰的迁移策略
3. **用户体验**：时间元数据的复杂性需要良好的抽象

---

## 六、总结

时间元数据的设计不仅关乎技术实现，更体现了对知识管理方法论的深刻思考。通过引入 IANA 时区、区分 createdAt 和 updatedAt，我们得以：

- **精确还原研究情境**：知道研究者在何时何地获取知识
- **追踪知识演化轨迹**：区分知识的「诞生」与「成长」
- **保持向后兼容**：让用户无痛过渡到新格式

这一设计决策的核心假设是：**时间和地点是知识轨迹的固有属性，而非可有可无的元数据**。

---

> **参考文档**：
> 
> - [AGENTS.md - 时间戳处理规范](../../AGENTS.md)
> - [searchNode 技术报告](./searchNode技术报告.md)
> - [MemFS 整体技术报告](./MemFS整体技术报告.md)
