#!/usr/bin/env node
/**
 * Memory Server 完整功能测试
 */

import { KnowledgeGraphManager } from './index.js';
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

async function test() {
    const timestamp = Date.now();
    const memoryPath = path.join(__dirname, '.test_' + timestamp + '.jsonl');
    const manager = new KnowledgeGraphManager(memoryPath);

    console.log('🧪 Memory Server 完整功能测试\n');
    console.log('测试时间: ' + new Date().toISOString());

    // ============================================================
    // 第一部分：基础 CRUD
    // ============================================================
    section('第一部分：基础 CRUD');

    const result = await manager.createEntity([
        {
            name: "JavaScript",
            entityType: "language",
            definition: "一种脚本语言，用于Web开发",
            definitionSource: "https://developer.mozilla.org/",
            observations: ["由Brendan Eich创建", "广泛用于前端"]
        },
        {
            name: "TypeScript",
            entityType: "language", 
            definition: "JavaScript的超集，添加了类型系统",
            observations: ["由微软开发", "编译为JavaScript"]
        },
        {
            name: "React",
            entityType: "framework",
            definition: "用于构建用户界面的JavaScript库",
            observations: ["由Meta开发", "使用JSX"]
        }
    ]);
    assert(result.newEntities.length === 3, "createEntity 创建3个实体");

    const relations = await manager.createRelation([
        { from: "React", to: "JavaScript", relationType: "builds_on" },
        { from: "React", to: "TypeScript", relationType: "builds_on" },
        { from: "TypeScript", to: "JavaScript", relationType: "compiles_to" }
    ]);
    assert(relations.length === 3, "createRelation 创建3个关系");

    // ============================================================
    // 第二部分：读取功能
    // ============================================================
    section('第二部分：读取功能');

    const nodes = await manager.listNode();
    assert(nodes.length === 3, "listNode 返回3个实体");
    assert('definitionSource' in nodes[0], "listNode 返回 definitionSource 字段");
    assert(!('observations' in nodes[0]), "listNode 不返回 observations 字段");

    const detail = await manager.readNode(["React"]);
    assert(detail.entities.length === 1, "readNode 返回1个实体");
    assert(detail.observations.length > 0, "readNode 返回观察");
    assert(detail.relations.length > 0, "readNode 返回关系");
    const reactToJs = detail.relations.find(r => r.to.name === "JavaScript");
    assert(reactToJs && 'entityType' in reactToJs.to, "关系内联包含 to 端 entityType");
    assert(reactToJs && 'definition' in reactToJs.to, "关系内联包含 to 端 definition");

    const full = await manager.listGraph();
    assert(full.entities.length === 3, "listGraph 返回3个实体");
    assert(full.observations.length > 0, "listGraph 返回观察");
    assert(full.relations.length === 3, "listGraph 返回3个关系");

    // ============================================================
    // 第三部分：搜索功能（多关键词去重）
    // ============================================================
    section('第三部分：搜索功能');

    const single1 = await manager.searchNode("JavaScript");
    assert(single1.entities.length >= 2, "单关键词搜索返回多个实体");

    const multi = await manager.searchNode("JavaScript 微软");
    assert(multi.entities.length >= 2, "多关键词返回多个实体");
    const names = multi.entities.map(e => e.name);
    assert(names.includes("JavaScript"), "包含 JavaScript");
    assert(names.includes("TypeScript"), "包含 TypeScript（微软）");

    const duplicate = await manager.searchNode("JavaScript JavaScript JavaScript");
    const uniqueNames = [...new Set(duplicate.entities.map(e => e.name))];
    assert(duplicate.entities.length === uniqueNames.length, "重复关键词已去重");

    // ============================================================
    // 第四部分：更新功能
    // ============================================================
    section('第四部分：更新功能');

    await manager.updateNode([{ entityName: "React", definition: "用于构建用户界面的JavaScript库（更新）" }]);
    const updated = await manager.readNode(["React"]);
    assert(updated.entities[0].definition.includes("更新"), "updateNode 更新定义成功");

    // ============================================================
    // 第五部分：删除功能
    // ============================================================
    section('第五部分：删除功能');

    const beforeRel = (await manager.readNode(["React"])).relations.length;
    await manager.deleteRelation([{ from: "React", to: "TypeScript", relationType: "builds_on" }]);
    const afterRel = (await manager.readNode(["React"])).relations.length;
    assert(afterRel < beforeRel, "deleteRelation 删除关系成功");

    const beforeDel = await manager.listGraph();
    const react = beforeDel.entities.find(e => e.name === "React");
    const obsToDelete = beforeDel.observations.find(o => 
        react && react.observationIds.includes(o.id) && o.content === "使用JSX"
    );
    
    if (obsToDelete) {
        const obsCountBefore = react.observationIds.length;
        await manager.unlinkObservation([{
            observation: "使用JSX",
            entityNames: ["React"]
        }]);
        
        const afterDel = await manager.readNode(["React"]);
        assert(afterDel.entities[0].observationIds.length < obsCountBefore, "unlinkObservation 解除链接成功");
        
        const orphans = await manager.getOrphanObservation();
        const orphanExists = orphans.some(o => o.content === "使用JSX");
        assert(orphanExists, "被删除的观察变为孤岛");
    } else {
        console.log('⚠️  没有找到要删除的观察');
    }

    // deleteEntity
    await manager.createEntity([{ name: "TestEntity", entityType: "test", definition: "测试用" }]);
    const beforeDelEntity = await manager.listNode();
    await manager.deleteEntity(["TestEntity"]);
    const afterDelEntity = await manager.listNode();
    assert(afterDelEntity.length < beforeDelEntity.length, "deleteEntity 删除实体成功");

    // ============================================================
    // 第六部分：孤岛检测
    // ============================================================
    section('第六部分：孤岛检测');

    const graph = await manager.loadGraph();
    const orphanId = Math.max(0, ...graph.observations.map(o => o.id)) + 1;
    graph.observations.push({ id: orphanId, content: "孤岛观察1", createdAt: new Date().toISOString() });
    await manager.saveGraph(graph);

    const orphans = await manager.getOrphanObservation();
    assert(orphans.length >= 1, "getOrphanObservation 检测到孤岛观察");

    // ============================================================
    // 第六部分：回收站功能
    // ============================================================
    section('第六部分：回收站功能');

    // 测试1：回收孤儿观察 - 应该成功
    const orphanBefore = await manager.getOrphanObservation();
    const orphanToRecycle = orphanBefore[0];
    if (orphanToRecycle) {
        const recycleResult = await manager.recycleObservation([orphanToRecycle.id]);
        assert(recycleResult.deleted.length === 1, "recycleObservation 删除孤儿观察成功");
        assert(recycleResult.skipped.length === 0, "recycleObservation 无跳过");
    }

    // 测试2：创建共享观察用于测试
    const createResult = await manager.createEntity([{
        name: "SharedTest",
        entityType: "test",
        definition: "共享观察测试",
        observations: ["共享观察内容"]
    }]);
    const sharedObsId = createResult.newEntities[0].observationIds[0];

    // 测试3：尝试删除非孤儿观察 - 应该跳过并警告
    const recycleSkipResult = await manager.recycleObservation([sharedObsId], false);
    assert(recycleSkipResult.skipped.length === 1, "recycleObservation 跳过被引用的观察");
    assert(recycleSkipResult.skipped[0].referencedBy.includes("SharedTest"), "recycleObservation 警告被哪些实体引用");
    assert(recycleSkipResult.warnings.length > 0, "recycleObservation 产生警告");

    // 验证观察仍然存在
    const afterSkip = await manager.listGraph();
    const stillExists = afterSkip.observations.some(o => o.id === sharedObsId);
    assert(stillExists, "跳过删除后观察仍然存在");

    // 测试4：强制删除非孤儿观察 - 应该成功但有警告
    const forceDeleteResult = await manager.recycleObservation([sharedObsId], true);
    assert(forceDeleteResult.deleted.length === 1, "recycleObservation 强制删除成功");
    assert(forceDeleteResult.deleted[0].forceDeleted === true, "recycleObservation 标记为强制删除");
    assert(Array.isArray(forceDeleteResult.deleted[0].referencedBy), "recycleObservation 返回被引用信息");
    assert(forceDeleteResult.warnings.length > 0, "recycleObservation 强制删除产生警告");

    // 验证观察已被删除
    const afterForce = await manager.listGraph();
    const deletedExists = afterForce.observations.some(o => o.id === sharedObsId);
    assert(!deletedExists, "强制删除后观察不再存在");

    // 验证实体的 observationIds 已被更新
    const sharedEntity = afterForce.entities.find(e => e.name === "SharedTest");
    assert(!sharedEntity.observationIds.includes(sharedObsId), "强制删除后实体observationIds已更新");

    // 清理测试实体
    await manager.deleteEntity(["SharedTest"]);

    // ============================================================
    // 第七部分：辅助功能
    // ============================================================
    section('第七部分：辅助功能');

    const workflow = await manager.howWork();
    assert(workflow.includes("listNode"), "howWork 返回推荐工作流");
    assert(workflow.includes("readNode"), "howWork 包含 readNode 说明");

    // ============================================================
    // 第八部分：readObservation 功能
    // ============================================================
    section('第八部分：readObservation 功能');

    // 先获取现有观察的 ID
    const obsGraph = await manager.listGraph();
    assert(obsGraph.observations.length > 0, "有观察可用于测试");
    
    const firstObs = obsGraph.observations[0];
    
    // 测试1：按 ID 读取单个观察
    const singleObs = await manager.readObservation([firstObs.id]);
    assert(singleObs.length === 1, "readObservation 返回1个观察");
    assert(singleObs[0].id === firstObs.id, "readObservation 返回正确ID");
    assert(singleObs[0].content === firstObs.content, "readObservation 返回正确内容");
    
    // 测试2：按 ID 读取多个观察
    if (obsGraph.observations.length >= 2) {
        const multiIds = [obsGraph.observations[0].id, obsGraph.observations[1].id];
        const multiObs = await manager.readObservation(multiIds);
        assert(multiObs.length === 2, "readObservation 返回多个观察");
    }
    
    // 测试3：不存在的 ID 应该被忽略
    const withInvalidIds = await manager.readObservation([firstObs.id, 99999, 88888]);
    assert(withInvalidIds.length === 1, "readObservation 忽略不存在的ID");
    
    // 测试4：空数组返回空结果
    const emptyResult = await manager.readObservation([]);
    assert(emptyResult.length === 0, "readObservation 空数组返回空结果");

    // ============================================================
    // 最终统计
    // ============================================================
    section('测试结果统计');

    console.log('\n总测试数: ' + testIndex);
    console.log('通过: ' + passCount + ' ✅');
    console.log('失败: ' + failCount + ' ❌');
    console.log('通过率: ' + ((passCount / testIndex) * 100).toFixed(1) + '%');

    const fs = await import('fs');
    await fs.promises.unlink(memoryPath).catch(() => {});

    if (failCount === 0) {
        console.log('\n🎉 所有测试通过！\n');
    } else {
        console.log('\n💥 有测试失败，请检查输出。\n');
        process.exit(1);
    }
}

test().catch(err => {
    console.error('测试执行失败:', err);
    process.exit(1);
});
