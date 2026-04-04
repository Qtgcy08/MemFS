#!/usr/bin/env node
/**
 * MCP 完整功能测试
 */

import { createMCPClient } from './mcp-client.js';
import path from 'path';
import { fileURLToPath } from 'url';

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
    // SDK returns { content: [...], structuredContent: {...} }
    if (result.structuredContent) {
        return result.structuredContent;
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

    console.log('🧪 MCP 完整功能测试 (16 个工具)\n');
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
                { entityName: JS, contents: ["广泛用于前端"] }
            ]
        });
        const addObsData = parseToolResult(addObsResult);
        assert(addObsData && !addObsData.error, '4. addObservation 添加观察');

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

        const delObsResult = await client.callTool('deleteObservation', {
            observationIds: [firstObsId],
            entityNames: [JS]
        });
        const delObsData = parseToolResult(delObsResult);
        assert(delObsData && !delObsData.error, '19. deleteObservation 解除链接');

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
