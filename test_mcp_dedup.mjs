#!/usr/bin/env node
/**
 * analyzeDuplicates 工具测试
 * 需 --duplicates 标志启用，通过 MCP 协议测试查重功能
 *
 * 备注：
 * - addObservation 有内容级去重（相同 content 自动 link），
 *   观察查重测试使用近似但不完全相同的文本
 * - createRelation 有精确去重 ((from,to,relationType) 三重匹配)，
 *   关系查重测试通过直接写入 JSONL 绕过
 */

import { createMCPClient } from './mcp-client.js';
import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let testIndex = 0;
let passCount = 0;
let failCount = 0;

function assert(condition, message) {
    testIndex++;
    if (condition) {
        passCount++;
        console.log('\u2705 ' + testIndex + '. ' + message);
    } else {
        failCount++;
        console.log('\u274c ' + testIndex + '. ' + message);
    }
}

function section(title) {
    console.log('\n' + '='.repeat(60));
    console.log(title);
    console.log('='.repeat(60) + '\n');
}

function parseToolResult(result) {
    if (result && result.jsonContent) return result.jsonContent;
    if (result && result.structuredContent) return result.structuredContent;
    if (!result || !result.content) return null;
    const textContent = result.content.find(c => c.type === 'text');
    if (!textContent) return null;
    try { return JSON.parse(textContent.text); } catch { return textContent.text; }
}

async function test() {
    const timestamp = Date.now();
    const memoryDir = path.join(__dirname, '.test_mcp_dedup_' + timestamp);

    // 预写入 JSONL 到 memory.jsonl（MEMORY_DIR 指向目录，服务器在目录内找 memory.jsonl）
    let obsId = 1;
    const entities = [
        { name: 'WebGPU', definition: '下一代 Web 图形与计算 API', entityType: 'API' },
        { name: 'WebGPU 规范', definition: '下一代 Web 图形与计算 API', entityType: 'API' },
        { name: 'WASI', definition: 'WebAssembly 系统接口', entityType: 'API' },
        { name: 'WASI 预览版', definition: 'WebAssembly 系统接口', entityType: 'API' },
        { name: '唯一实体', definition: '这个实体没有重复', entityType: '测试' }
    ];

    const obsContents = [
        // WebGPU 的观察
        { content: '由 W3C 社区组制定标准', entityIdx: 0 },
        { content: '2024 年 Chrome 118 起可用', entityIdx: 0 },
        // WebGPU 规范的观察（近似但不相同）
        { content: '由 W3C 社区组发布标准', entityIdx: 1 },
        { content: '定义着色器语言 WGSL', entityIdx: 1 },
        // WASI 的观察
        { content: '提供标准化系统调用接口', entityIdx: 2 },
        { content: '让 WASM 脱离浏览器运行', entityIdx: 2 },
        // WASI 预览版的观察（近似但不相同）
        { content: '提供标准化的系统调用抽象', entityIdx: 3 },
        { content: '预览版 2 已增加 HTTP 支持', entityIdx: 3 },
        // 唯一实体的观察
        { content: '仅此一条', entityIdx: 4 }
    ];

    // 构建 JSONL
    const lines = [];
    for (const [idx, e] of entities.entries()) {
        const obsIds = obsContents.filter(o => o.entityIdx === idx).map(() => obsId++);
        lines.push(JSON.stringify({
            type: 'entity',
            name: e.name,
            entityType: e.entityType,
            definition: e.definition,
            observationIds: obsIds
        }));
    }
    for (const oc of obsContents) {
        const oid = obsContents.indexOf(oc) + 1; // 1-based
        lines.push(JSON.stringify({
            type: 'observation',
            id: oid,
            content: oc.content,
            createdAt: { utc: '2026-01-01T00:00:00Z', timezone: 'Asia/Shanghai' }
        }));
    }
    // 重复关系：从→到 相同但 relationType 重复（绕过 createRelation 去重）
    lines.push(JSON.stringify({ type: 'relation', from: 'WebGPU', to: 'WebGPU 规范', relationType: 'relates_to' }));
    lines.push(JSON.stringify({ type: 'relation', from: 'WebGPU', to: 'WebGPU 规范', relationType: 'relates_to' }));
    lines.push(JSON.stringify({ type: 'relation', from: 'WASI', to: 'WASI 预览版', relationType: 'relates_to' }));
    // 正常关系（非重复）
    lines.push(JSON.stringify({ type: 'relation', from: '唯一实体', to: 'WebGPU', relationType: '参考' }));

    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(path.join(memoryDir, 'memory.jsonl'), lines.join('\n') + '\n');

    const client = createMCPClient({ MEMORY_DIR: memoryDir }, ['--duplicates']);

    console.log('\ud83e\uddea analyzeDuplicates 查重工具测试\n');
    console.log('测试时间: ' + new Date().toISOString());
    console.log('测试目录: ' + memoryDir);

    try {
        await client.start();
        console.log('\u2705 MCP 服务器已启动 (--duplicates)\n');

        // 验证工具列表
        const tools = await client.listTools();
        const toolNames = tools.map(t => t.name);
        assert(toolNames.includes('analyzeDuplicates'), '工具列表包含 analyzeDuplicates');

        // ============================================================
        // 测试 1: entity 范围查重
        // ============================================================
        section('1. Entity 查重');

        const entityResult = await client.callTool('analyzeDuplicates', {
            scope: 'entity', threshold: 0.3, maxPairs: 10
        });
        const entityData = parseToolResult(entityResult);
        assert(entityData && entityData.entityPairs, 'entityPairs 存在');
        assert(entityData.entityPairs.length >= 2, '至少发现 2 组实体重复');

        const hasWebGPUPair = entityData.entityPairs.some(p =>
            (p.entityA.name === 'WebGPU' && p.entityB.name === 'WebGPU 规范') ||
            (p.entityA.name === 'WebGPU 规范' && p.entityB.name === 'WebGPU')
        );
        assert(hasWebGPUPair, '检出 WebGPU ~ WebGPU 规范 重复');

        const hasWASIPair = entityData.entityPairs.some(p =>
            (p.entityA.name === 'WASI' && p.entityB.name === 'WASI 预览版') ||
            (p.entityA.name === 'WASI 预览版' && p.entityB.name === 'WASI')
        );
        assert(hasWASIPair, '检出 WASI ~ WASI 预览版 重复');

        // 唯一实体不与任何实体匹配
        const uniquePair = entityData.entityPairs.some(p =>
            p.entityA.name === '唯一实体' || p.entityB.name === '唯一实体'
        );
        assert(!uniquePair, '唯一实体未被误判为重复');

        // ============================================================
        // 测试 2: observation 范围查重
        // ============================================================
        section('2. Observation 查重');

        const obsResult = await client.callTool('analyzeDuplicates', {
            scope: 'observation', threshold: 0.3, maxPairs: 10
        });
        const obsData = parseToolResult(obsResult);
        assert(obsData && obsData.observationPairs, 'observationPairs 存在');
        assert(obsData.observationPairs.length >= 1, '至少发现 1 组观察重复');

        // 验证近似观察 "由 W3C 社区组制定标准" ~ "由 W3C 社区组发布标准"
        const hasW3CObs = obsData.observationPairs.some(p =>
            p.observationA.content.includes('W3C') || p.observationB.content.includes('W3C')
        );
        assert(hasW3CObs, '检出 W3C 相关观察重复');

        // 验证近似观察 "提供标准化系统调用接口" ~ "提供标准化的系统调用抽象"
        const hasSyscallObs = obsData.observationPairs.some(p =>
            p.observationA.content.includes('系统调用') || p.observationB.content.includes('系统调用')
        );
        assert(hasSyscallObs, '检出 系统调用 相关观察重复');

        // ============================================================
        // 测试 3: relation 范围查重
        // ============================================================
        section('3. Relation 查重');

        const relResult = await client.callTool('analyzeDuplicates', {
            scope: 'relation', maxPairs: 10
        });
        const relData = parseToolResult(relResult);
        assert(relData && relData.relationDuplicates, 'relationDuplicates 存在');
        assert(relData.relationDuplicates.length >= 1, '至少发现 1 组关系重复');

        const hasWebGPURel = relData.relationDuplicates.some(r =>
            r.from === 'WebGPU' && r.to === 'WebGPU 规范'
        );
        assert(hasWebGPURel, '检出 WebGPU → WebGPU 规范 重复关系');

        // 非重复关系不应被误报
        const hasCleanRel = relData.relationDuplicates.some(r =>
            r.from === '唯一实体'
        );
        assert(!hasCleanRel, '唯一实体的关系未被误判为重复');

        // ============================================================
        // 测试 4: all 范围查重
        // ============================================================
        section('4. All 范围查重');

        const allResult = await client.callTool('analyzeDuplicates', {
            scope: 'all', threshold: 0.3, maxPairs: 20
        });
        const allData = parseToolResult(allResult);
        assert(allData, '返回数据存在');
        assert(allData.observationPairs.length >= 1, 'observation 查重结果存在');
        assert(allData.entityPairs.length >= 2, 'entity 查重结果存在');
        assert(allData.relationDuplicates.length >= 1, 'relation 查重结果存在');
        assert('stats' in allData, 'stats 字段存在');
        assert(typeof allData.stats.duration === 'number', 'duration 为数字');
        assert(allData.entityPairs.some(p => 'normalizedScore' in p), 'entityPairs 含 normalizedScore');
        assert(allData.observationPairs.some(p => 'normalizedScore' in p), 'observationPairs 含 normalizedScore');
        for (const p of allData.entityPairs) {
            assert(p.normalizedScore >= 0 && p.normalizedScore <= 1, 'normalizedScore 在 [0,1] 范围');
        }

        // ============================================================
        // 测试 5: 参数边界
        // ============================================================
        section('5. 参数边界');

        // 极高的 threshold 应返回空结果
        const highResult = await client.callTool('analyzeDuplicates', {
            threshold: 99, maxPairs: 10
        });
        const highData = parseToolResult(highResult);
        assert(highData, '高 threshold 返回数据存在');
        const highEmpty = (highData.entityPairs || []).length === 0
            && (highData.observationPairs || []).length === 0
            && (highData.relationDuplicates || []).length === 0;
        assert(highEmpty, '高 threshold (99) 无匹配');

        // maxPairs=1 应只返回 1 条
        const max1Result = await client.callTool('analyzeDuplicates', {
            scope: 'entity', threshold: 0.3, maxPairs: 1
        });
        const max1Data = parseToolResult(max1Result);
        assert(max1Data, 'maxPairs=1 返回数据存在');
        assert(max1Data.entityPairs.length <= 1, 'maxPairs=1 最多返回 1 条');

        // 默认参数调用应无异常
        const defaultResult = await client.callTool('analyzeDuplicates', {});
        const defaultData = parseToolResult(defaultResult);
        assert(defaultData, '默认参数调用成功');
        assert(defaultData.stats, '默认参数有 stats');

        console.log('\n');

    } catch (err) {
        console.error('\u274c 测试异常:', err.message);
        console.error(err.stack);
    } finally {
        await client.cleanupTestData();
        await client.stop();
        try { await fs.rm(memoryDir, { recursive: true, force: true }); } catch { /* ok */ }
    }

    // ============================================================
    console.log('='.repeat(60));
    console.log('\n总测试数: ' + testIndex);
    console.log('\u2705 通过: ' + passCount);
    console.log('\u274c 失败: ' + failCount);
    console.log('通过率: ' + (testIndex > 0 ? (passCount / testIndex * 100).toFixed(1) : 0) + '%\n');

    if (failCount > 0) process.exit(1);
}

test().catch(err => { console.error('Fatal error:', err); process.exit(1); });
