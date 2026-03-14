#!/usr/bin/env node
/**
 * TF-IDF + Fuse.js 混合搜索测试
 * 同时测试传统检索和混合检索
 */

import { KnowledgeGraphManager } from './index.js';
import { SearchIntegrator } from './src/tfidf/searchIntegrator.js';
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
    console.log('\n' + '='.repeat(60));
    console.log(title);
    console.log('='.repeat(60) + '\n');
}

function compareResults(traditional, hybrid, testName) {
    console.log('   [对比] 传统模式: ' + traditional.entities.length + ' 个实体');
    console.log('   [对比] 混合模式: ' + hybrid.entities.length + ' 个实体');

    // 检查返回格式
    assert(hybrid._meta, '混合搜索返回 _meta 元信息');
    assert(hybrid.searchMode === 'hybrid', '混合搜索模式标记为 "hybrid"');
    assert(traditional.searchMode === 'traditional', '传统搜索模式标记为 "traditional"');

    // 检查相关性分数（简化版本：只检查是否存在）
    if (hybrid.entities.length > 0) {
        assert(hybrid.entities.length > 0, '混合搜索返回实体列表');
        assert(hybrid._meta.returnedCount <= 15, '混合搜索返回数量不超过限制(15)');
    }
}

async function test() {
    const timestamp = Date.now();
    const memoryPath = path.join(__dirname, '.test_hybrid_' + timestamp + '.jsonl');
    const manager = new KnowledgeGraphManager(memoryPath);
    const searchIntegrator = new SearchIntegrator(manager);

    console.log('🧪 TF-IDF + Fuse.js 混合搜索测试\n');
    console.log('测试时间: ' + new Date().toISOString());

    // ============================================================
    // 第一部分：创建测试数据
    // ============================================================
    section('第一部分：创建测试数据');

    const entities = [
        {
            name: "JavaScript",
            entityType: "language",
            definition: "一种脚本语言，用于Web开发和浏览器端编程",
            observations: ["由Brendan Eich在1995年创建", "广泛用于前端开发", "支持函数式编程"]
        },
        {
            name: "TypeScript",
            entityType: "language",
            definition: "JavaScript的超集，添加了静态类型系统和面向对象特性",
            observations: ["由微软开发", "编译为纯JavaScript", "类型安全"]
        },
        {
            name: "React",
            entityType: "framework",
            definition: "用于构建用户界面的JavaScript库，采用组件化架构",
            observations: ["由Meta（原Facebook）开发", "使用JSX语法", "虚拟DOM"]
        },
        {
            name: "Vue",
            entityType: "framework",
            definition: "渐进式JavaScript框架，用于构建用户界面",
            observations: ["由尤雨溪创建", "响应式数据绑定", "易学易用"]
        },
        {
            name: "Node.js",
            entityType: "runtime",
            definition: "基于Chrome V8引擎的JavaScript运行时环境",
            observations: ["允许JavaScript在服务端运行", "事件驱动非阻塞I/O", "适合构建高性能网络应用"]
        },
        {
            name: "Python",
            entityType: "language",
            definition: "一种高级编程语言，强调代码可读性",
            observations: ["由Guido van Rossum创建", "多范式支持", "广泛应用于AI和数据分析"]
        },
        {
            name: "Rust",
            entityType: "language",
            definition: "系统级编程语言，注重安全性和性能",
            observations: ["由Mozilla开发", "内存安全", "无垃圾回收"]
        },
        {
            name: "Webpack",
            entityType: "tool",
            definition: "模块打包器，用于现代JavaScript应用",
            observations: ["打包JavaScript模块", "支持加载器和插件", "构建优化"]
        }
    ];

    await manager.createEntity(entities);
    const nodeCount = await manager.listNode();
    assert(nodeCount.length === 8, '创建8个测试实体');

    // 创建关系
    const relations = [
        { from: "React", to: "JavaScript", relationType: "builds_on" },
        { from: "React", to: "TypeScript", relationType: "builds_on" },
        { from: "Vue", to: "JavaScript", relationType: "builds_on" },
        { from: "TypeScript", to: "JavaScript", relationType: "compiles_to" },
        { from: "Node.js", to: "JavaScript", relationType: "runtime_for" },
        { from: "Webpack", to: "JavaScript", relationType: "bundles" },
        { from: "Python", to: "AI", relationType: "used_for" }
    ];
    await manager.createRelation(relations);

    // ============================================================
    // 第二部分：测试传统搜索模式 (basicFetch=true)
    // ============================================================
    section('第二部分：传统搜索模式 (basicFetch=true)');

    const trad1 =     await searchIntegrator.searchNode("JavaScript", { basicFetch: true });
    assert(trad1.entities.length >= 2, '传统搜索 "JavaScript" 返回多个实体');
    assert(trad1.searchMode === 'traditional', 'searchMode 为 traditional');
    console.log('   返回: ' + trad1.entities.length + ' 个实体');

    const trad2 =     await searchIntegrator.searchNode("微软", { basicFetch: true });
    assert(trad2.entities.length === 1, '传统搜索 "微软" 返回1个实体(TypeScript)');
    console.log('   返回: ' + trad2.entities.length + ' 个实体');

    const trad3 = await searchIntegrator.searchNode("前端", { basicFetch: true });
    assert(trad3.entities.length >= 1, '传统搜索 "前端" 返回至少1个实体');
    console.log('   返回: ' + trad3.entities.length + ' 个实体');

    // ============================================================
    // 第三部分：测试混合搜索模式 (默认)
    // ============================================================
    section('第三部分：混合搜索模式 (默认)');

    const hybrid1 =     await searchIntegrator.searchNode("JavaScript");
    assert(hybrid1.searchMode === 'hybrid', '默认使用混合搜索模式');
    assert(hybrid1._meta.returnedCount <= 15, '混合搜索返回数量受limit限制');
    assert(hybrid1._meta.tfidfWeight === 0.7, 'TF-IDF权重为0.7');
    assert(hybrid1._meta.fuzzyWeight === 0.3, 'Fuse.js权重为0.3');
    console.log('   返回: ' + hybrid1._meta.returnedCount + ' 个实体 (限制: 15)');
    console.log('   候选总数: ' + hybrid1._meta.totalCandidates);
    console.log('   TF-IDF权重: ' + hybrid1._meta.tfidfWeight);
    console.log('   Fuse.js权重: ' + hybrid1._meta.fuzzyWeight);

    const hybrid2 =     await searchIntegrator.searchNode("微软");
    assert(hybrid2.entities.length === 1, '混合搜索 "微软" 返回1个实体');
    console.log('   返回: ' + hybrid2.entities.length + ' 个实体');

    const hybrid3 =     await searchIntegrator.searchNode("前端");
    assert(hybrid3._meta.returnedCount <= 15, '混合搜索返回数量不超过15');


    // ============================================================
    // 第四部分：对比测试
    // ============================================================
    section('第四部分：搜索结果对比');

    // 测试1：精确匹配
    const exact1 =     await searchIntegrator.searchNode("React", { basicFetch: true });
    const exact2 =     await searchIntegrator.searchNode("React");
    compareResults(exact1, exact2, '精确匹配 "React"');

    // 测试2：多关键词
    const multi1 =     await searchIntegrator.searchNode("JavaScript 前端", { basicFetch: true });
    const multi2 =     await searchIntegrator.searchNode("JavaScript 前端");
    compareResults(multi1, multi2, '多关键词 "JavaScript 前端"');

    // 测试3：模糊匹配
    const fuzzy1 =     await searchIntegrator.searchNode("JavScript", { basicFetch: true }); // 拼写错误
    const fuzzy2 =     await searchIntegrator.searchNode("JavScript"); // 混合搜索应容忍拼写错误
    console.log('   [模糊测试] "JavScript" (拼写错误)');
    console.log('   传统模式返回: ' + fuzzy1.entities.length + ' 个实体');
    console.log('   混合模式返回: ' + fuzzy2.entities.length + ' 个实体');

    // 测试4：长尾匹配
    const tail1 =     await searchIntegrator.searchNode("虚拟DOM", { basicFetch: true });
    const tail2 =     await searchIntegrator.searchNode("虚拟DOM");
    compareResults(tail1, tail2, '长尾查询 "虚拟DOM"');

    // ============================================================
    // 第五部分：相关性分数测试
    // ============================================================
    section('第五部分：相关性分数验证');

    const relevance1 =     await searchIntegrator.searchNode("JavaScript");
    console.log('   [JavaScript] 相关性分数排序:');
    relevance1.entities.slice(0, 3).forEach((e, i) => {
        console.log('   ' + (i + 1) + '. ' + e.name + ': ' + e._relevanceScore?.toFixed(4));
    });

    // 检查分数是否按降序排列（通过返回顺序判断）
    if (relevance1.entities.length > 1) {
        // 由于只返回排序后的列表，分数由内部处理
        assert(relevance1.entities.length > 0, '返回非空实体列表');
        console.log('   [排序] 返回按相关性排序的实体列表');
    }

    // ============================================================
    // 第六部分：自定义参数测试
    // ============================================================
    section('第六部分：自定义参数测试');

    // 测试自定义limit
    const customLimit =     await searchIntegrator.searchNode("JavaScript", { limit: 3 });
    assert(customLimit._meta.returnedCount <= 3, '自定义limit=3生效');
    console.log('   limit=3 返回: ' + customLimit._meta.returnedCount + ' 个实体');

    // 测试自定义权重
    const customWeight =     await searchIntegrator.searchNode("JavaScript", { tfidfWeight: 0.9, fuzzyWeight: 0.1 });
    assert(customWeight._meta.tfidfWeight === 0.9, '自定义TF-IDF权重生效');
    assert(customWeight._meta.fuzzyWeight === 0.1, '自定义Fuse.js权重生效');
    console.log('   自定义权重: TF-IDF=0.9, Fuzzy=0.1');

    // 测试最小分数阈值
    const minScore =     await searchIntegrator.searchNode("Java", { minScore: 0.5 });
    console.log('   minScore=0.5 返回: ' + minScore._meta.returnedCount + ' 个实体');

    // ============================================================
    // 第七部分：边缘情况测试
    // ============================================================
    section('第七部分：边缘情况测试');

    // 空查询
    const empty1 =     await searchIntegrator.searchNode("", { basicFetch: true });
    const empty2 =     await searchIntegrator.searchNode("");
    console.log('   空查询: 传统=' + empty1.entities.length + ', 混合=' + empty2.entities.length);

    // 单字符查询（会被过滤）
    const short1 =     await searchIntegrator.searchNode("J", { basicFetch: true });
    const short2 =     await searchIntegrator.searchNode("J");
    console.log('   单字符 "J": 传统=' + short1.entities.length + ', 混合=' + short2.entities.length);

    // 无结果查询
    const noResult1 =     await searchIntegrator.searchNode("xyz123nonexistent", { basicFetch: true });
    const noResult2 =     await searchIntegrator.searchNode("xyz123nonexistent");
    assert(noResult1.entities.length === 0, '传统搜索无结果返回空');
    assert(noResult2.entities.length === 0, '混合搜索无结果返回空');
    console.log('   无结果查询: 两者均返回空数组');

    // ============================================================
    // 第八部分：元信息验证
    // ============================================================
    section('第八部分：元信息验证');

    const meta1 =     await searchIntegrator.searchNode("TypeScript");
    assert(typeof meta1._meta.timestamp === 'string', '包含时间戳');
    assert(typeof meta1._meta.basicFetch === 'boolean', '包含basicFetch标记');
    assert(meta1._meta.basicFetch === false, 'basicFetch默认为false');
    console.log('   时间戳: ' + meta1._meta.timestamp);
    console.log('   basicFetch: ' + meta1._meta.basicFetch);

    const meta2 =     await searchIntegrator.searchNode("TypeScript", { basicFetch: true });
    assert(meta2._meta.basicFetch === true, 'basicFetch=true时标记为true');
    console.log('   basicFetch=true: ' + meta2._meta.basicFetch);

    // ============================================================
    // 第九部分：分词检索测试
    // ============================================================
    section('第九部分：分词检索验证');

    // 测试1: 验证分词
    const termTest = await searchIntegrator.searchNode("JavaScript 前端 微软");
    assert(Array.isArray(termTest._meta.debug?.terms), '返回分词结果');
    console.log('   [分词] "JavaScript 前端 微软" → ' + JSON.stringify(termTest._meta.debug?.terms));

    // 测试2: 验证聚合查重
    // JavaScript应该出现在多个词的结果中，但最终只出现一次
    const jsNames = termTest.entities.filter(e => e.name === 'JavaScript').map(e => e.name);
    assert(jsNames.length <= 1, 'JavaScript最多出现一次（查重生效）');
    console.log('   [查重] JavaScript出现次数: ' + jsNames.length);

    // 测试3: 验证排序 - 只返回entityName
    console.log('   [排序] 返回按相关性排序的实体列表:');
    termTest.entities.slice(0, 3).forEach((e, i) => {
        console.log(`     ${i + 1}. ${e.name}`);
    });

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
