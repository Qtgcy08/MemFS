#!/usr/bin/env node
import { KnowledgeGraphManager } from './index.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testMemoryPath = path.join(__dirname, 'test-memory.jsonl');

async function cleanup() {
    try {
        await fs.unlink(testMemoryPath);
    } catch (e) {}
}

async function test() {
    await cleanup();
    console.log('=== 测试开始 ===\n');

    const manager = new KnowledgeGraphManager(testMemoryPath);

    // 1. 测试 create_entities（带 definition）
    console.log('1. 测试 create_entities（带 definition）');
    const entities = await manager.createEntities([
        {
            name: "定义",
            entityType: "逻辑学概念",
            definition: "揭示概念内涵的逻辑方法，揭示反映在概念中的事物的特有属性",
            observations: ["来自词项逻辑", "传统逻辑中的重要方法"]
        },
        {
            name: "概念",
            entityType: "逻辑学",
            definition: "反映事物特有属性的思维形式"
        }
    ]);
    console.log('创建实体结果:');
    console.log(JSON.stringify(entities, null, 2));
    console.log('');

    // 2. 测试 read_nodes
    console.log('2. 测试 read_nodes');
    const nodes = await manager.readNodes();
    console.log('读取节点结果:');
    console.log(JSON.stringify(nodes, null, 2));
    console.log('');

    // 3. 测试 add_observations
    console.log('3. 测试 add_observations');
    const obsResult = await manager.addObservations([
        {
            entityName: "概念",
            contents: ["是逻辑学的基本单位", "具有内涵和外延"]
        }
    ]);
    console.log('添加观察结果:');
    console.log(JSON.stringify(obsResult, null, 2));
    console.log('');

    // 4. 测试 read_graph（检查观察是否集中存储）
    console.log('4. 测试 read_graph（检查集中存储）');
    const graph = await manager.readGraph();
    console.log('读取图谱结果:');
    console.log('Entities:', JSON.stringify(graph.entities, null, 2));
    console.log('\nObservations (集中存储):', JSON.stringify(graph.observations, null, 2));
    console.log('');

    // 5. 测试 update_nodes
    console.log('5. 测试 update_nodes');
    const updateResult = await manager.updateNodes([
        {
            entityName: "定义",
            name: "新定义",
            entityType: "哲学概念",
            observationUpdates: [
                { oldContent: "来自词项逻辑", newContent: "来自形式逻辑" }
            ]
        }
    ]);
    console.log('更新节点结果:');
    console.log(JSON.stringify(updateResult, null, 2));
    console.log('');

    // 6. 测试 update_observation
    console.log('6. 测试 update_observation');
    // 找到 observations 的 ID
    const conceptEntity = (await manager.readNodes()).find(n => n.name === "概念");
    const obsId = conceptEntity?.observationIds?.[0];
    if (obsId) {
        const updateObsResult = await manager.updateObservation(obsId, "逻辑学的基本思维单位");
        console.log('更新观察结果:');
        console.log(JSON.stringify(updateObsResult, null, 2));
    }
    console.log('');

    // 7. 测试 search_nodes
    console.log('7. 测试 search_nodes');
    const searchResult = await manager.searchNodes("逻辑");
    console.log('搜索"逻辑"结果:');
    console.log(JSON.stringify(searchResult, null, 2));
    console.log('');

    console.log('=== 测试完成 ===');

    await cleanup();
}

test().catch(console.error);
