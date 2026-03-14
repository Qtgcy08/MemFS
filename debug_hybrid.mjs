#!/usr/bin/env node
/**
 * Debug HybridSearchService for xyz123nonexistent
 */

import { KnowledgeGraphManager } from './index.js';
import { HybridSearchService } from './src/tfidf/hybridSearchService.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function test() {
    const timestamp = Date.now();
    const memoryPath = path.join(__dirname, '.test_hybrid_' + timestamp + '.jsonl');
    const manager = new KnowledgeGraphManager(memoryPath);
    const searcher = new HybridSearchService({});

    // Create test data (same as test file)
    const entities = [
        { name: "JavaScript", entityType: "language", definition: "一种脚本语言，用于Web开发和浏览器端编程", observations: ["由Brendan Eich在1995年创建", "广泛用于前端开发", "支持函数式编程"] },
        { name: "TypeScript", entityType: "language", definition: "JavaScript的超集，添加了静态类型系统和面向对象特性", observations: ["由微软开发", "编译为纯JavaScript", "类型安全"] },
        { name: "React", entityType: "framework", definition: "用于构建用户界面的JavaScript库，采用组件化架构", observations: ["由Meta（原Facebook）开发", "使用JSX语法", "虚拟DOM"] },
        { name: "Vue", entityType: "framework", definition: "渐进式JavaScript框架，用于构建用户界面", observations: ["由尤雨溪创建", "响应式数据绑定", "易学易用"] },
        { name: "Node.js", entityType: "runtime", definition: "基于Chrome V8引擎的JavaScript运行时环境", observations: ["允许JavaScript在服务端运行", "事件驱动非阻塞I/O", "适合构建高性能网络应用"] },
        { name: "Python", entityType: "language", definition: "一种高级编程语言，强调代码可读性", observations: ["由Guido van Rossum创建", "多范式支持", "广泛应用于AI和数据分析"] },
        { name: "Rust", entityType: "language", definition: "系统级编程语言，注重安全性和性能", observations: ["由Mozilla开发", "内存安全", "无垃圾回收"] },
        { name: "Webpack", entityType: "tool", definition: "模块打包器，用于现代JavaScript应用", observations: ["打包JavaScript模块", "支持加载器和插件", "构建优化"] }
    ];

    await manager.createEntity(entities);
    await searcher.buildIndex(
        (await manager.listGraph()).entities,
        (await manager.listGraph()).observations
    );

    console.log('=== Testing xyz123nonexistent ===\n');

    // Check tokenization
    const query = "xyz123nonexistent";
    console.log(`Query: "${query}"`);

    // Test each token manually
    const tokens = ["xyz", "yz1", "z12", "123", "23n", "3no", "non", "one", "nex", "exi", "xis", "ist", "ste", "ten", "ent"];
    console.log('\nTesting individual tokens:');
    tokens.forEach(token => {
        const results = searcher.searchTerm(token);
        console.log(`  "${token}": TF-IDF=${results.tfidfCount}, Fuse=${results.fuseCount}`);
    });

    // Full search
    console.log('\nFull hybrid search:');
    const result = searcher.search(query);
    console.log(`  results.length: ${result.results.length}`);
    console.log(`  entities: ${result.results.map(e => e.entityName).join(', ')}`);

    // Cleanup
    try {
        await fs.unlink(memoryPath);
    } catch (e) {}
}

test().catch(console.error);
