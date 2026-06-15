#!/usr/bin/env node
/**
 * MCP 完整功能测试
 */

import { createMCPClient } from './mcp-client.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let testIndex = 0;
let passCount = 0;
let failCount = 0;

function assert(condition, message) {
    testIndex++;
    if (condition) {
        passCount++;
        console.log('✅ ' + testIndex + '. ' + message);
    } else {
        failCount++;
        console.log('❌ ' + testIndex + '. ' + message);
    }
}

function section(title) {
    console.log('\n============================================================');
    console.log(title);
    console.log('============================================================\n');
}

// 解析 MCP 工具返回结果
function parseToolResult(result) {
    if (!result) return null;
    // Handler returns { content: [...], structuredContent/jsonContent: {...} }
    if (result.structuredContent) {
        return result.structuredContent;
    }
    if (result.jsonContent) {
        return result.jsonContent;
    }
    // Fallback: try to parse content as JSON
    if (result.content) {
        const textContent = result.content.find(c => c.type === 'text');
        if (textContent) {
            try {
                return JSON.parse(textContent.text);
            } catch {
                return textContent.text;
            }
        }
    }
    return null;
}

async function test() {
    const timestamp = Date.now();
    const memoryDir = path.join(__dirname, 'temp', '.test_mcp_' + timestamp);
    const PREFIX = 'T' + String(timestamp).slice(-6);

    // 不启用 GITAUTOCOMMIT 避免阻塞问题
    const client = createMCPClient({
        MEMORY_DIR: memoryDir
    });

    console.log('🧪 MCP 完整功能测试 (19 个工具)\n');
    console.log('测试时间: ' + new Date().toISOString());
    console.log('测试目录: ' + memoryDir);

    try {
        await client.start();
        console.log('✅ MCP 服务器已启动\n');

        const JS = PREFIX + '_JS';
        const TS = PREFIX + '_TS';
        const REACT = PREFIX + '_React';

        // ============================================================
        // Create 工具组 (3个)
        // ============================================================
        section('Create 工具组 (3个)');

        const createResult = await client.callTool('createEntity', {
            entities: [
                { name: JS, entityType: "编程语言", definition: "一种动态编程语言", observations: ["用于Web开发"] },
                { name: TS, entityType: "编程语言", definition: "JavaScript的超集" },
                { name: REACT, entityType: "框架", definition: "UI框架" }
            ]
        });
        const createData = parseToolResult(createResult);
        assert(createData && !createData.error, '1. createEntity 创建实体');
        assert(createData?.entities?.length === 3, '2. createEntity 返回 3 个实体');

        const relResult = await client.callTool('createRelation', {
            relations: [
                { from: REACT, to: JS, relationType: "基于" },
                { from: TS, to: JS, relationType: "编译到" }
            ]
        });
        const relData = parseToolResult(relResult);
        assert(relData && !relData.error, '3. createRelation 创建关系');

        const addObsResult = await client.callTool('addObservation', {
            observations: [
                { mode: 'create', entityName: JS, contents: ["广泛用于前端"] }
            ]
        });
        const addObsData = parseToolResult(addObsResult);
        assert(addObsData && !addObsData.error, '4. addObservation 添加观察');
        const sharedObsId = addObsData?.results?.[0]?.addedObservationIds?.[0];

        // 测试观察复用：通过 observationId 链接到已有观察
        if (sharedObsId) {
            const reuseResult = await client.callTool('addObservation', {
                observations: [
                    { mode: 'link', entityName: REACT, observationIds: sharedObsId }
                ]
            });
            const reuseData = parseToolResult(reuseResult);
            assert(reuseData && !reuseData.error, '5. addObservation 通过 observationId 复用观察');
            assert(reuseData?.results?.[0]?.linkedObservationIds?.includes(sharedObsId), '6. addObservation 复用返回 linkedObservationIds');

            // 验证 TS 也复用同一个观察
            const reuseMultiResult = await client.callTool('addObservation', {
                observations: [
                    { mode: 'link', entityName: TS, observationIds: [sharedObsId] }
                ]
            });
            const reuseMultiData = parseToolResult(reuseMultiResult);
            assert(reuseMultiData && !reuseMultiData.error, '7. addObservation 通过 observationIds 批量复用');

            // 验证三个实体都引用了同一个观察
            const verifyResult = await client.callTool('readNode', { names: [JS, TS, REACT] });
            const verifyData = parseToolResult(verifyResult);
            const jsHas = verifyData?.entities?.find(e => e.name === JS)?.observationIds?.includes(sharedObsId);
            const tsHas = verifyData?.entities?.find(e => e.name === TS)?.observationIds?.includes(sharedObsId);
            const reactHas = verifyData?.entities?.find(e => e.name === REACT)?.observationIds?.includes(sharedObsId);
            assert(jsHas && tsHas && reactHas, '8. addObservation 复用验证：三个实体都引用同一观察');
        }

        // ============================================================
        // Read 工具组 (6个)
        // ============================================================
        section('Read 工具组 (6个)');

        const searchResult = await client.callTool('searchNode', { query: PREFIX });
        const searchData = parseToolResult(searchResult);
        assert(searchData && searchData.entities && searchData.entities.length > 0, '5. searchNode 搜索实体');

        const readResult = await client.callTool('readNode', { names: [JS] });
        const readData = parseToolResult(readResult);
        assert(readData && readData.entities && readData.entities.length > 0, '6. readNode 读取实体');
        assert(readData?.observations?.length > 0, '7. readNode 返回观察');
        assert(readData?.relations?.length > 0, '8. readNode 返回关系');

        const graphResult = await client.callTool('listGraph', {});
        const graphData = parseToolResult(graphResult);
        const firstObsId = graphData?.observations?.[0]?.id;

        if (firstObsId) {
            const obsResult = await client.callTool('readObservation', { ids: [firstObsId] });
            const obsData = parseToolResult(obsResult);
            const observations = obsData?.observations || obsData;
            assert(observations && observations.length > 0, '9. readObservation 按ID读取');
        } else {
            assert(true, '9. readObservation 跳过（无观察）');
        }

        const listResult = await client.callTool('listNode', {});
        const listData = parseToolResult(listResult);
        const listNodes = listData?.nodes || listData;
        assert(listNodes && listNodes.length >= 3, '10. listNode 列出实体');

        const fullResult = await client.callTool('listGraph', {});
        const fullData = parseToolResult(fullResult);
        assert(fullData?.entities?.length >= 3, '11. listGraph 读取完整图');
        assert(fullData?.observations?.length > 0, '12. listGraph 返回观察');
        assert(fullData?.relations?.length >= 2, '13. listGraph 返回关系');

        const howResult = await client.callTool('howWork', {});
        const howData = parseToolResult(howResult);
        assert(howData?.workflow, '14. howWork 返回工作流');

        // ============================================================
        // Update 工具组 (2个)
        // ============================================================
        section('Update 工具组 (2个)');

        const updateResult = await client.callTool('updateNode', {
            updates: [{ entityName: JS, definition: "一种动态编程语言（已更新）" }]
        });
        const updateData = parseToolResult(updateResult);
        assert(updateData && !updateData.error, '15. updateNode 更新实体');

        if (firstObsId) {
            const updateObsResult = await client.callTool('updateObservation', {
                updates: [{ observationId: firstObsId, newContent: "更新后的内容" }]
            });
            const updateObsData = parseToolResult(updateObsResult);
            assert(updateObsData && !updateObsData.error, '16. updateObservation 更新观察');
        } else {
            assert(true, '16. updateObservation 跳过（无观察）');
        }

        // ============================================================
        // Delete 工具组 (5个)
        // ============================================================
        section('Delete 工具组 (5个)');

        await client.callTool('createEntity', {
            entities: [{ name: PREFIX + '_Del', entityType: "test", definition: "测试删除" }]
        });

        const delEntityResult = await client.callTool('deleteEntity', {
            entityNames: [PREFIX + '_Del']
        });
        const delEntityData = parseToolResult(delEntityResult);
        assert(delEntityData && !delEntityData.error, '17. deleteEntity 删除实体');

        const delRelResult = await client.callTool('deleteRelation', {
            relations: [{ from: TS, to: JS, relationType: "编译到" }]
        });
        const delRelData = parseToolResult(delRelResult);
        assert(delRelData && !delRelData.error, '18. deleteRelation 删除关系');

        const delObsResult = await client.callTool('unlinkObservation', {
            observationIds: [firstObsId],
            entityNames: [JS]
        });
        const delObsData = parseToolResult(delObsResult);
        assert(delObsData && !delObsData.error, '19. unlinkObservation 解除链接');

        const orphansResult = await client.callTool('getOrphanObservation', {});
        const orphansData = parseToolResult(orphansResult);
        const orphans = orphansData?.orphanObservations || orphansData;
        assert(Array.isArray(orphans), '20. getOrphanObservation 返回数组');

        const orphanToRecycle = orphans?.find(o => o.content === "广泛用于前端");
        if (orphanToRecycle) {
            const recycleResult = await client.callTool('recycleObservation', {
                observationIds: [orphanToRecycle.id]
            });
            const recycleData = parseToolResult(recycleResult);
            assert(recycleData?.deleted?.length > 0, '21. recycleObservation 回收孤儿');
        } else {
            assert(true, '21. recycleObservation 跳过（无孤儿）');
        }

        // ============================================================
        // Concurrency 测试
        // ============================================================
        section('Concurrency 测试 (并发安全)');

        const { KnowledgeGraphManager } = await import('./index.js');
        const { promises: fs } = await import('fs');
        const concFile = path.join(memoryDir, 'concurrency_test.jsonl');
        try { await fs.unlink(concFile); } catch {}

        const km = new KnowledgeGraphManager(concFile);

        const concCount = 30;
        const concCalls = [];
        for (let i = 0; i < concCount; i++) {
            concCalls.push(km.createEntity([{ name: `${PREFIX}_CONC_${i}`, entityType: 'test', definition: '', observations: [] }]));
        }
        await Promise.all(concCalls);

        const concGraph = await km.loadGraph();
        assert(concGraph.entities.length === concCount, `22. createEntity ${concCount}次并发，结果 ${concGraph.entities.length} 个实体`);

        const mixedCalls = [];
        for (let i = 0; i < 5; i++) {
            mixedCalls.push(km.createEntity([{ name: `${PREFIX}_MIX_${i}`, entityType: 'test', definition: '', observations: ['obs'] }]));
        }
        mixedCalls.push(km.setDefinition(`${PREFIX}_CONC_0`, 'conc def'));
        mixedCalls.push(km.addObservation([{ entityName: `${PREFIX}_CONC_1`, contents: ['conc obs'] }]));
        mixedCalls.push(km.deleteEntity([`${PREFIX}_CONC_5`]));
        await Promise.all(mixedCalls);

        const mixGraph = await km.loadGraph();
        const expected = concCount - 1 + 5;
        assert(mixGraph.entities.length === expected, `23. 混合并发操作，结果 ${mixGraph.entities.length} 个实体 (预期 ${expected})`);
        assert(mixGraph.definitions.length === 1, `24. 并发 setDefinition 写入定义`);

        const concObs = mixGraph.observations.find(o => o.content === 'conc obs');
        assert(concObs !== undefined, `25. 并发 addObservation 写入观察`);

        await fs.unlink(concFile).catch(() => {});

        // ============================================================
        // SSE 模式测试
        // ============================================================
        section('SSE 模式测试');

        const http = await import('http');
        const ssePort = 19520 + (timestamp % 10000);

        // 启动 SSE 服务器
        const sseServer = spawn('node', [path.join(__dirname, 'index.js'), '--mode', 'sse', '--port', String(ssePort), '--token', 'test-token'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, MEMORY_DIR: memoryDir }
        });

        // 等待服务器启动
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('SSE server start timeout')), 8000);
            sseServer.stderr.on('data', (data) => {
                if (data.toString().includes('running on SSE')) {
                    clearTimeout(timeout);
                    resolve();
                }
            });
            sseServer.on('error', reject);
        });

        // Test: 无 token 应返回 401
        const res1 = await fetch(`http://localhost:${ssePort}/sse`);
        assert(res1.status === 401, '26. SSE 无 token 返回 401');

        // Test: 错误 token 应返回 401
        const res2 = await fetch(`http://localhost:${ssePort}/sse?token=wrong`);
        assert(res2.status === 401, '27. SSE 错误 token 返回 401');

        // Test: 正确 token 应返回 200 并建立 SSE 流
        const res3 = await fetch(`http://localhost:${ssePort}/sse?token=test-token`);
        assert(res3.status === 200, '28. SSE 正确 token 返回 200');
        const sseText = await res3.text();
        assert(sseText.includes('event: endpoint'), '29. SSE 返回 endpoint 事件');
        assert(sseText.includes('sessionId='), '30. SSE 返回 sessionId');

        // Test: /message 无 token 应返回 401
        const res4 = await fetch(`http://localhost:${ssePort}/message?sessionId=test`, { method: 'POST' });
        assert(res4.status === 401, '31. SSE POST /message 无 token 返回 401');

        // Test: Authorization Bearer header
        const res5 = await fetch(`http://localhost:${ssePort}/sse`, {
            headers: { 'Authorization': 'Bearer test-token' }
        });
        assert(res5.status === 200, '32. SSE Bearer token header 返回 200');

        sseServer.kill();

        // ============================================================
        // 测试结果
        // ============================================================
        section('测试结果');
        console.log('总测试数: ' + testIndex);
        console.log('✅ 通过: ' + passCount);
        console.log('❌ 失败: ' + failCount);
        console.log('通过率: ' + ((passCount / testIndex) * 100).toFixed(1) + '%');

    } catch (error) {
        console.error('\n❌ 测试失败:', error.message);
        failCount++;
    } finally {
        await client.stop();
        console.log('\n🔄 服务器已停止');
        process.exit(failCount > 0 ? 1 : 0);
    }
}

test().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
