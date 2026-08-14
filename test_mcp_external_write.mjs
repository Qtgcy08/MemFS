#!/usr/bin/env node
/**
 * 外部写入感知测试（TTL/mtime 修复）
 *
 * 复现场景：多实例共享同一 JSONL 时，实例 B 写入后，实例 A 的 30s TTL
 * 缓存不感知外部修改（症状：searchNode 空，reloadnow 后命中）。
 *
 * 修复后 loadGraph 以文件 mtime/size/存在性为准校验缓存，外部写入立即
 * 触发 reload，且搜索索引同步失效重建。
 */
import { KnowledgeGraphManager } from './index.js';
import { SearchIntegrator } from './src/tfidf/searchIntegrator.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let testIndex = 0;
let passCount = 0;
let failCount = 0;

function assert(condition, message) {
    testIndex++;
    if (condition) { passCount++; console.log('✅ ' + testIndex + '. ' + message); }
    else { failCount++; console.log('❌ ' + testIndex + '. ' + message); }
}

function section(title) {
    console.log('\n' + '='.repeat(60) + '\n' + title + '\n' + '='.repeat(60));
}

async function test() {
    const timestamp = Date.now();
    const memoryDir = path.join(__dirname, 'temp', '.test_ext_' + timestamp);
    await fs.mkdir(memoryDir, { recursive: true });
    const memoryFile = path.join(memoryDir, 'memory.jsonl');

    section('多实例共享 JSONL 的外部写入感知');

    // 实例 A：加载并保持缓存热（30s TTL 窗口内）
    const kmA = new KnowledgeGraphManager(memoryFile);
    await kmA.loadGraph();
    const si = new SearchIntegrator(kmA);
    kmA.searchIntegrator = si;

    // 实例 B：独立的 KnowledgeGraphManager，写入同一文件
    const kmB = new KnowledgeGraphManager(memoryFile);
    const created = await kmB.createEntity([{
        name: 'Ext_Write_A',
        entityType: 'test',
        definition: 'written by instance B',
        observations: []
    }]);
    assert(created.newEntities.length === 1, '实例 B 创建实体成功');

    // 实例 A 无需等待 TTL 过期，立即感知（mtime 变化触发 reload）
    const graphA = await kmA.loadGraph();
    assert(graphA.entities.some(e => e.name === 'Ext_Write_A'),
        '实例 A 立即感知实例 B 的写入（不等 30s TTL）');

    // 搜索索引同步失效：searchNode 立即命中
    await si.ensureIndex();
    const hits = await si.searchNode('Ext_Write_A', { limit: 10 });
    assert(Array.isArray(hits.entities) && hits.entities.some(e => e.name === 'Ext_Write_A'),
        '实例 A 的搜索索引立即感知外部写入');

    // 原始文件追加（绕过管理器，直接改 JSONL）
    const rawLine = JSON.stringify({
        type: 'entity',
        name: 'Ext_Write_B',
        entityType: 'test',
        definition: 'raw external append',
        observationIds: []
    });
    await fs.appendFile(memoryFile, '\n' + rawLine + '\n');

    const graphB = await kmA.loadGraph();
    assert(graphB.entities.some(e => e.name === 'Ext_Write_B'),
        '原始 append 写入（绕过管理器）立即可见');

    await kmA.close();
    await kmB.close();

    section('文件缺失 → 出现');
    const memoryFile2 = path.join(memoryDir, 'memory2.jsonl');
    const kmC = new KnowledgeGraphManager(memoryFile2);
    await kmC.loadGraph();   // 缓存空图（文件不存在）
    await fs.writeFile(memoryFile2, JSON.stringify({
        type: 'entity',
        name: 'Ext_Write_C',
        entityType: 'test',
        definition: 'file created externally',
        observationIds: []
    }) + '\n');
    const graphC = await kmC.loadGraph();
    assert(graphC.entities.some(e => e.name === 'Ext_Write_C'),
        '文件从缺失到出现立即可感知');
    await kmC.close();

    console.log(`\n${passCount} passed, ${failCount} failed`);
    process.exit(failCount > 0 ? 1 : 0);
}

test().catch((error) => {
    console.error(error);
    process.exit(1);
});
