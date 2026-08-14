#!/usr/bin/env node
// Streamable HTTP transport tests — spawns real server subprocesses.
// Usage: node test_mcp_streamable_http.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'httptesttoken';

let testIndex = 0;
let passCount = 0;
let failCount = 0;
let portSeq = 0;

function assert(condition, message) {
    testIndex++;
    if (condition) { passCount++; console.log('✅ ' + testIndex + '. ' + message); }
    else { failCount++; console.log('❌ ' + testIndex + '. ' + message); }
}

function section(title) {
    console.log('\n' + '='.repeat(60) + '\n' + title + '\n' + '='.repeat(60));
}

async function startServer(mode) {
    const memoryDir = path.join(__dirname, 'temp', `.test_http_${mode}_${Date.now()}`);
    await fs.mkdir(memoryDir, { recursive: true });
    portSeq++;
    const port = 20000 + ((portSeq * 97) % 20000);
    const child = spawn('node', [path.join(__dirname, 'index.js'),
        '--mode', mode, '--port', String(port), '--token', TOKEN], {
        env: { ...process.env, MEMORY_DIR: memoryDir },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(mode + ' start timeout')), 10000);
        child.stderr.on('data', (data) => {
            if (data.toString().includes('running on')) { clearTimeout(timeout); resolve(); }
        });
        child.on('error', reject);
    });
    return { child, port, memoryDir };
}

async function stopServer(child) {
    return new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGTERM');
        setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
    });
}

async function main() {
    const base = 'http://127.0.0.1';

    // ========== Streamable HTTP + SSE 并存 ==========
    section('Streamable HTTP + SSE 并存 (--mode both)');
    const both = await startServer('both');
    const url = `${base}:${both.port}/mcp`;

    // 认证与非法请求
    let r = await fetch(url);
    assert(r.status === 401, 'GET /mcp 无 token 返回 401');
    r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });
    assert(r.status === 401, 'POST /mcp 错误 token 返回 401');
    r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
    assert(r.status === 400, 'POST /mcp 非 initialize 且无会话返回 400');

    // 官方客户端建立有状态会话
    const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } }
    });
    const client = new Client({ name: 'memfs-http-test', version: '1.0.0' });
    await client.connect(transport);
    assert(typeof transport.sessionId === 'string' && transport.sessionId.length > 0, '客户端获得 mcp-session-id');

    const tools = await client.request({ method: 'tools/list', params: {} }, z.unknown());
    assert(Array.isArray(tools.tools) && tools.tools.length >= 17, `tools/list 返回 ${tools.tools.length} 个工具`);

    const createRes = await client.request({
        method: 'tools/call',
        params: {
            name: 'createEntity',
            arguments: { entities: [{ name: 'HttpTest_Entity', entityType: 'test', definition: 'streamable http test' }] }
        }
    }, z.unknown());
    assert(!createRes.isError && JSON.stringify(createRes.content).includes('HttpTest_Entity'),
        'createEntity 通过 Streamable HTTP 调用成功');

    const listRes = await client.request({
        method: 'tools/call',
        params: { name: 'listNode', arguments: { tree: false } }
    }, z.unknown());
    assert(JSON.stringify(listRes.content).includes('HttpTest_Entity'), '同一会话第二次调用读到新建实体');

    // 第二个独立会话（多会话并发）
    const transport2 = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } }
    });
    const client2 = new Client({ name: 'memfs-http-test-2', version: '1.0.0' });
    await client2.connect(transport2);
    assert(transport2.sessionId !== transport.sessionId, '第二个客户端获得独立 session id');
    const listRes2 = await client2.request({
        method: 'tools/call',
        params: { name: 'listNode', arguments: { tree: false } }
    }, z.unknown());
    assert(JSON.stringify(listRes2.content).includes('HttpTest_Entity'), '第二个会话看到同一知识图谱');
    await client2.close();

    // DELETE 关闭会话
    const del = await fetch(url, {
        method: 'DELETE',
        headers: { 'mcp-session-id': transport.sessionId, authorization: `Bearer ${TOKEN}` }
    });
    assert(del.status === 200, 'DELETE /mcp 关闭会话返回 200');
    r = await fetch(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'mcp-session-id': transport.sessionId,
            authorization: `Bearer ${TOKEN}`
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    });
    assert(r.status === 400, '已关闭会话的后续请求返回 400');
    await client.close().catch(() => {});

    // SSE 端点并存
    const sseRes = await fetch(`${base}:${both.port}/sse?token=${TOKEN}`);
    assert(sseRes.status === 200, 'SSE 端点 (both 模式) 返回 200');
    const reader = sseRes.body.getReader();
    const chunk = await reader.read();
    const sseText = new TextDecoder().decode(chunk.value);
    assert(sseText.includes('event: endpoint') && sseText.includes('sessionId='), 'SSE 流返回 endpoint 事件与 sessionId');
    await reader.cancel();

    await stopServer(both.child);

    // ========== 模式隔离 ==========
    section('模式隔离');
    const httpOnly = await startServer('http');
    r = await fetch(`${base}:${httpOnly.port}/sse?token=${TOKEN}`);
    assert(r.status === 404, '--mode http 下 /sse 返回 404');
    const t3 = new StreamableHTTPClientTransport(new URL(`${base}:${httpOnly.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } }
    });
    const c3 = new Client({ name: 'memfs-http-test-3', version: '1.0.0' });
    await c3.connect(t3);
    const tools3 = await c3.request({ method: 'tools/list', params: {} }, z.unknown());
    assert(tools3.tools.length >= 17, '--mode http 下 /mcp 正常');
    await c3.close();
    await stopServer(httpOnly.child);

    const sseOnly = await startServer('sse');
    r = await fetch(`${base}:${sseOnly.port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: '{}'
    });
    assert(r.status === 404, '--mode sse 下 /mcp 返回 404');
    await stopServer(sseOnly.child);

    console.log(`\n${passCount} passed, ${failCount} failed`);
    process.exit(failCount > 0 ? 1 : 0);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
