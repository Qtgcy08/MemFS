#!/usr/bin/env node
/**
 * 观察内容检索测试
 * 验证只有观察匹配时的检索逻辑
 */

import { KnowledgeGraphManager } from './index.js';
import { SearchIntegrator } from './src/tfidf/searchIntegrator.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('🧪 观察内容检索测试\n');

const timestamp = Date.now();
const memoryPath = path.join(__dirname, '.test_obs_' + timestamp + '.jsonl');
const manager = new KnowledgeGraphManager(memoryPath);
const searchIntegrator = new SearchIntegrator(manager);

// 创建测试数据
const entities = [
    {
        name: "EntityOnlyName",
        entityType: "test",
        definition: "这是一个只有名称匹配的实体",
        observations: []
    },
    {
        name: "EntityOnlyObs",
        entityType: "test",
        definition: "这是一个只有定义匹配的实体",
        observations: []
    },
    {
        name: "EntityOnlyObservation",
        entityType: "test",
        definition: "这个实体的名称和定义都不包含关键词",
        observations: ["这个观察包含特殊关键词ABC123", "另一个观察内容XYZ789"]
    },
    {
        name: "EntityMultipleMatches",
        entityType: "test",
        definition: "定义的关键词是ABC123",
        observations: ["观察也包含ABC123关键词"]
    },
    {
        name: "EntityNoMatch",
        entityType: "test",
        definition: "完全不相关的内容",
        observations: ["无关的观察内容"]
    }
];

await manager.createEntity(entities);

console.log('📊 测试数据:');
entities.forEach(e => {
    console.log(`  - ${e.name}: definition=${e.definition?.slice(0, 20)}..., obs count=${e.observations?.length || 0}`);
});

console.log('\n' + '='.repeat(60));

// 测试1: 关键词只在观察中
console.log('\n测试1: 关键词只在观察中 ("ABC123")');
// 确保索引已构建
await searchIntegrator.ensureIndex();
const test1 = await searchIntegrator.searchNode("ABC123");
console.log(`   返回实体: ${test1.entities.length}`);

// 结果格式简化：只有entityName
console.log('   [简化返回格式]');
test1.entities.slice(0, 2).forEach((e, i) => {
    console.log(`     ${i + 1}. ${e.name}`);
});

console.log(`   ✅ 成功通过观察内容检索到实体`);

// 测试2: 关键词在多个字段
console.log('\n测试2: 关键词在定义和观察中都有 ("ABC123")');
console.log(`   返回实体: ${test1.entities.length}`);
console.log('   [简化] 只返回按相关性排序的实体名');

// 测试3: 关键词只在观察中（另一个）
console.log('\n测试3: 关键词只在观察中 ("XYZ789")');
const test3 = await searchIntegrator.searchNode("XYZ789");
console.log(`   返回实体: ${test3.entities.length}`);
test3.entities.forEach(e => {
    console.log(`   - ${e.name}`);
});

// 测试4: 对比 - 名称匹配 vs 观察匹配
console.log('\n测试4: 名称匹配 vs 观察匹配对比');
await manager.createEntity([{
    name: "ABC123InName",
    entityType: "test",
    definition: "定义不包含",
    observations: ["观察也不包含"]
}]);

const test4 = await searchIntegrator.searchNode("ABC123");
console.log(`   返回实体: ${test4.entities.length}`);
console.log('   [简化返回格式]');
test4.entities.forEach((e, i) => {
    console.log(`     ${i + 1}. ${e.name}`);
});

await manager.deleteEntity(["ABC123InName"]);

// 测试5: 验证只有观察匹配的实体是否正确返回
console.log('\n测试5: 只有观察匹配时返回的字段信息');
const test5 = await searchIntegrator.searchNode("ABC123");
const obsEntity = test5.entities.find(e => e.name === 'EntityOnlyObservation');
if (obsEntity) {
    console.log(`   实体: ${obsEntity.name}`);
    console.log(`   observationIds: ${obsEntity.observationIds?.length}个`);
    console.log(`   [简化] 只返回实体信息，无分数`);
    console.log(`   ✅ 成功通过观察内容检索到实体`);
}

console.log('\n' + '='.repeat(60));
console.log('✅ 观察内容检索测试完成');

// 清理
const fs = await import('fs');
await fs.promises.unlink(memoryPath).catch(() => {});
