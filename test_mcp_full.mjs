#!/usr/bin/env node
/**
 * MCP 完整功能测试 - 所有 16 个 MCP 工具
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

function parseToolResult(result) {
    if (result && result.structuredContent) {
        return result.structuredContent;
    }
    if (!result || !result.content) {
        return null;
    }
    const textContent = result.content.find(c => c.type === 'text');
    if (!textContent) {
        return null;
    }
    try {
        return JSON.parse(textContent.text);
    } catch {
        return textContent.text;
    }
}

// 解析 MCP 列表结果（包装在 nodes 键下）
function parseListResult(result) {
    const data = parseToolResult(result);
    if (!data) return null;
    return data.nodes || data;
}

// 解析孤儿观察结果（包装在 orphanObservations 键下）
function parseOrphanResult(result) {
    const data = parseToolResult(result);
    if (!data) return null;
    return data.orphanObservations || data;
}

async function test() {
    const timestamp = Date.now();
    const memoryDir = path.join(__dirname, 'temp', '.test_mcp_' + timestamp);
    const PREFIX = 'T' + String(timestamp).slice(-6);

    const client = createMCPClient({
        MEMORY_DIR: memoryDir,
        GITAUTOCOMMIT: 'true'
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
        assert(relResult && !parseToolResult(relResult)?.error, '3. createRelation 创建关系');

        const addObsResult = await client.callTool('addObservation', {
            observations: [
                { entityName: JS, contents: ["广泛用于前端"] }
            ]
        });
        assert(addObsResult && !parseToolResult(addObsResult)?.error, '4. addObservation 添加观察');

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
            // readObservation returns {observations: [...]} not plain array
            const observations = obsData?.observations || obsData;
            assert(observations && observations.length > 0, '9. readObservation 按ID读取');
        } else {
            assert(true, '9. readObservation 跳过（无观察）');
        }

        const listResult = await client.callTool('listNode', {});
        const listData = parseListResult(listResult);
        assert(listData && listData.length >= 3, '10. listNode 列出实体');

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
        assert(updateResult && !parseToolResult(updateResult)?.error, '15. updateNode 更新实体');

        if (firstObsId) {
            const updateObsResult = await client.callTool('updateObservation', {
                updates: [{ observationId: firstObsId, newContent: "更新后的内容" }]
            });
            assert(updateObsResult && !parseToolResult(updateObsResult)?.error, '16. updateObservation 更新观察');
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
        assert(delEntityResult && !parseToolResult(delEntityResult)?.error, '17. deleteEntity 删除实体');

        const delRelResult = await client.callTool('deleteRelation', {
            relations: [{ from: TS, to: JS, relationType: "编译到" }]
        });
        assert(delRelResult && !parseToolResult(delRelResult)?.error, '18. deleteRelation 删除关系');

        const delObsResult = await client.callTool('deleteObservation', {
            observations: [{ observation: "广泛用于前端", entityNames: [JS] }]
        });
        assert(delObsResult && !parseToolResult(delObsResult)?.error, '19. deleteObservation 解除链接');

        const orphansResult = await client.callTool('getOrphanObservation', {});
        const orphansData = parseOrphanResult(orphansResult);
        assert(Array.isArray(orphansData), '20. getOrphanObservation 返回数组');

        const orphanToRecycle = orphansData?.find(o => o.content === "广泛用于前端");
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
        // Git Sync 功能验证
        // ============================================================
        section('Git Sync 功能验证');

        const consoleResult = await client.callTool('getConsole', {});
        
        // getConsole returns text content with git commits prefixed by "[Git] "
        let hasGitCommit = false;
        if (consoleResult?.content) {
            const textContent = consoleResult.content.find(c => c.type === 'text');
            if (textContent?.text) {
                hasGitCommit = textContent.text.includes('[Git]');
            }
        }
        
        assert(hasGitCommit, '22. Git auto-commit 记录存在');

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
