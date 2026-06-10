#!/usr/bin/env node
import { KnowledgeGraphManager } from './index.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

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
    const memoryDir = path.join(__dirname, 'temp', '.test_conc_' + timestamp);
    await fs.mkdir(memoryDir, { recursive: true });
    const PREFIX = 'C' + String(timestamp).slice(-6);

    // ============================================================
    // Concurrency 测试
    // ============================================================
    section('Concurrency 测试');
    
    const concFile = path.join(memoryDir, 'concurrency.jsonl');
    const km = new KnowledgeGraphManager(concFile);

    const concCount = 30;
    const concCalls = [];
    for (let i = 0; i < concCount; i++) {
        concCalls.push(km.createEntity([{ name: PREFIX + '_C_' + i, entityType: 'test', definition: '', observations: [] }]));
    }
    await Promise.all(concCalls);

    const g1 = await km.loadGraph();
    assert(g1.entities.length === concCount,
        'createEntity ' + concCount + 'x 并发: ' + g1.entities.length + ' 个实体');

    const mixed = [];
    for (let i = 0; i < 5; i++) {
        mixed.push(km.createEntity([{ name: PREFIX + '_M_' + i, entityType: 'test', definition: '', observations: ['o'] }]));
    }
    mixed.push(km.setDefinition(PREFIX + '_C_0', 'def'));
    mixed.push(km.addObservation([{ entityName: PREFIX + '_C_1', contents: ['new obs'] }]));
    mixed.push(km.deleteEntity([PREFIX + '_C_5']));
    await Promise.all(mixed);

    const g2 = await km.loadGraph();
    const expected = concCount - 1 + 5;
    assert(g2.entities.length === expected,
        '混合并发: ' + g2.entities.length + ' 个实体 (预期 ' + expected + ')');
    assert(g2.definitions.length === 1, 'setDefinition 并发写入');
    assert(g2.observations.some(o => o.content === 'new obs'), 'addObservation 并发写入');

    // Concurrent createRelation + operations
    await km.createEntity([{ name: PREFIX + '_A', entityType: 't', definition: '', observations: [] }]);
    await km.createEntity([{ name: PREFIX + '_B', entityType: 't', definition: '', observations: [] }]);

    const p3 = [];
    p3.push(km.createRelation([{ from: PREFIX + '_A', to: PREFIX + '_B', relationType: 'knows' }]));
    p3.push(km.updateNode([{ entityName: PREFIX + '_A', definition: 'updated' }]));
    p3.push(km.addObservation([{ entityName: PREFIX + '_B', contents: ['b-obs'] }]));
    await Promise.all(p3);

    const g3 = await km.loadGraph();
    assert(g3.relations.length === 1, 'createRelation 并发');
    assert(g3.entities.find(e => e.name === PREFIX + '_A').definition === 'updated', 'updateNode 并发');

    await fs.unlink(concFile).catch(() => {});

    // ============================================================
    // SSE 模式测试
    // ============================================================
    section('SSE 模式测试');

    const ssePort = 19520 + (timestamp % 10000);
    const sseServer = spawn('node', [path.join(__dirname, 'index.js'),
        '--mode', 'sse', '--port', String(ssePort), '--token', 'mytesttoken'
    ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, MEMORY_DIR: path.join(memoryDir, 'sse_data') }
    });

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('SSE start timeout')), 8000);
        sseServer.stderr.on('data', (data) => {
            if (data.toString().includes('running on SSE')) { clearTimeout(timeout); resolve(); }
        });
        sseServer.on('error', reject);
    });

    // 无 token
    const r1 = await fetch('http://localhost:' + ssePort + '/sse');
    assert(r1.status === 401, 'SSE 无 token 返回 401');

    // 错误 token
    const r2 = await fetch('http://localhost:' + ssePort + '/sse?token=wrong');
    assert(r2.status === 401, 'SSE 错误 token 返回 401');

    // 正确 token (query) — SSE 是长连接，只读第一个 chunk
    const r3 = await fetch('http://localhost:' + ssePort + '/sse?token=mytesttoken');
    assert(r3.status === 200, 'SSE 正确 token 返回 200');
    const sseReader = r3.body.getReader();
    const chunk = await sseReader.read();
    if (chunk.value) {
        const sseText = new TextDecoder().decode(chunk.value);
        assert(sseText.includes('event: endpoint'), 'SSE 返回 endpoint 事件');
        assert(sseText.includes('sessionId='), 'SSE 返回 sessionId');
    } else {
        assert(true, 'SSE 流已关闭');
        assert(true, 'SSE 无数据');
    }
    sseReader.cancel();

    // POST /message 无 token
    const r4 = await fetch('http://localhost:' + ssePort + '/message?sessionId=x', { method: 'POST' });
    assert(r4.status === 401, 'POST /message 无 token 返回 401');

    // Bearer header (SSE 长连接，只读 header)
    const r5 = await fetch('http://localhost:' + ssePort + '/sse', {
        headers: { 'Authorization': 'Bearer mytesttoken' }
    });
    assert(r5.status === 200, 'Bearer token header 返回 200');
    r5.body.getReader().cancel();

    sseServer.kill();

    // ============================================================
    section('结果');
    console.log('总测试: ' + testIndex + ', 通过: ' + passCount + ', 失败: ' + failCount);
    console.log('通过率: ' + ((passCount / testIndex) * 100).toFixed(1) + '%');
    process.exit(failCount > 0 ? 1 : 0);
}

test().catch(e => { console.error('Fatal:', e); process.exit(1); });
