#!/usr/bin/env node
/**
 * MemFS 数据统计脚本
 * 统计知识图谱的各项指标
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const memoryPath = process.argv[2] || path.join(__dirname, 'memory.jsonl');

async function loadGraph(filePath) {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    
    const entities = [];
    const observations = [];
    const relations = [];
    
    for (const line of lines) {
        try {
            const obj = JSON.parse(line);
            if (obj.type === 'entity') {
                entities.push(obj);
            } else if (obj.type === 'observation') {
                observations.push(obj);
            } else if (obj.type === 'relation') {
                relations.push(obj);
            }
        } catch (e) {
            // Skip invalid JSON lines
        }
    }
    
    return { entities, observations, relations };
}

// N-gram tokenizer for stats
function cleanText(text) {
    return text
        .replace(/[\u3000-\u303f\uff00-\uffef!@#$%^&*()_+\-=\[\]{}|;':",.\/<>?`~\\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function generateNGram(text, n) {
    const result = [];
    for (let i = 0; i <= text.length - n; i++) {
        result.push(text.slice(i, i + n));
    }
    return result;
}

function tokenizeForStats(text) {
    const cleaned = cleanText(text);
    if (!cleaned || cleaned.length < 2) return [];
    
    const tokens = new Set();
    tokens.add(cleaned);
    
    // Incremental n-gram
    if (cleaned.length >= 3) generateNGram(cleaned, 2).forEach(t => tokens.add(t));
    if (cleaned.length >= 4) generateNGram(cleaned, 3).forEach(t => tokens.add(t));
    if (cleaned.length >= 5) generateNGram(cleaned, 4).forEach(t => tokens.add(t));
    
    return Array.from(tokens);
}

async function calculateStats(graph, memoryPath) {
    const { entities, observations, relations } = graph;
    
    console.log('\n' + '='.repeat(60));
    console.log('📊 MemFS 知识图谱统计报告');
    console.log('='.repeat(60));
    console.log(`\n📁 数据文件: ${memoryPath}`);
    console.log(`⏰ 统计时间: ${new Date().toISOString()}\n`);
    
    // 1. 基础统计
    console.log('-'.repeat(60));
    console.log('📈 基础统计');
    console.log('-'.repeat(60));
    console.log(`  总实体数:     ${entities.length}`);
    console.log(`  总观察数:     ${observations.length}`);
    console.log(`  总关系数:     ${relations.length}`);
    
    // 2. 平均值
    console.log('\n' + '-'.repeat(60));
    console.log('📐 平均值统计');
    console.log('-'.repeat(60));
    const avgObservations = entities.length > 0 
        ? (observations.length / entities.length).toFixed(2) 
        : '0';
    const avgRelations = entities.length > 0 
        ? (relations.length / entities.length).toFixed(2) 
        : '0';
    console.log(`  平均每实体观察数: ${avgObservations}`);
    console.log(`  平均每实体关系数: ${avgRelations}`);
    
    // 3. 观察最多的实体 Top5
    console.log('\n' + '-'.repeat(60));
    console.log('🔍 观察最多的实体 Top5');
    console.log('-'.repeat(60));
    const entityObsCount = entities
        .map(e => ({ name: e.name, count: e.observationIds?.length || 0 }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
    entityObsCount.forEach((e, i) => {
        console.log(`  ${i + 1}. ${e.name} (${e.count} 条观察)`);
    });
    
    // 4. 联系最多的实体 Top5
    console.log('\n' + '-'.repeat(60));
    console.log('🔗 关联最多的实体 Top5');
    console.log('-'.repeat(60));
    const entityRelCount = {};
    relations.forEach(r => {
        entityRelCount[r.from] = (entityRelCount[r.from] || 0) + 1;
        entityRelCount[r.to] = (entityRelCount[r.to] || 0) + 1;
    });
    const topConnected = Object.entries(entityRelCount)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
    topConnected.forEach((e, i) => {
        console.log(`  ${i + 1}. ${e.name} (${e.count} 条关联)`);
    });
    
    // 5. 最新修改的观察 Top5
    console.log('\n' + '-'.repeat(60));
    console.log('🕐 最新修改的观察 Top5 (by updatedAt/createdAt)');
    console.log('-'.repeat(60));
    const sortedObs = observations
        .filter(o => o.createdAt || o.updatedAt)
        .map(o => {
            const time = o.updatedAt?.utc || o.createdAt?.utc || '';
            return { 
                id: o.id, 
                content: o.content?.slice(0, 30) + '...',
                time,
                raw: o
            };
        })
        .sort((a, b) => {
            if (!a.time) return 1;
            if (!b.time) return -1;
            return new Date(b.time) - new Date(a.time);
        })
        .slice(0, 5);
    sortedObs.forEach((o, i) => {
        const date = o.time ? new Date(o.time).toLocaleString() : 'N/A';
        console.log(`  ${i + 1}. [${date}] ${o.content}`);
    });
    
    // 6. 热门 Gram Tokens Top10
    console.log('\n' + '-'.repeat(60));
    console.log('🔥 热门 Gram Tokens Top10 (从实体/观察内容提取)');
    console.log('-'.repeat(60));
    const tokenCounts = {};
    
    // 从实体 name, entityType, definition 提取 tokens
    entities.forEach(e => {
        if (e.name) tokenizeForStats(e.name).forEach(t => tokenCounts[t] = (tokenCounts[t] || 0) + 1);
        if (e.entityType) tokenizeForStats(e.entityType).forEach(t => tokenCounts[t] = (tokenCounts[t] || 0) + 1);
        if (e.definition) tokenizeForStats(e.definition).forEach(t => tokenCounts[t] = (tokenCounts[t] || 0) + 1);
    });
    
    // 从 observation 提取 tokens
    observations.forEach(obs => {
        if (!obs.content) return;
        tokenizeForStats(obs.content).forEach(token => {
            tokenCounts[token] = (tokenCounts[token] || 0) + 1;
        });
    });
    // Filter: 只保留出现次数 > 1 且非纯数字的 tokens
    const filteredTokens = Object.entries(tokenCounts)
        .filter(([token, count]) => count > 1 && !/^\d+$/.test(token))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
    filteredTokens.forEach(([token, count], i) => {
        console.log(`  ${i + 1}. "${token}" (出现 ${count} 次)`);
    });
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ 统计完成');
    console.log('='.repeat(60) + '\n');
}

async function main() {
    try {
        console.log('\n🔄 正在加载数据...');
        const graph = await loadGraph(memoryPath);
        console.log(`✅ 已加载: ${graph.entities.length} 实体, ${graph.observations.length} 观察, ${graph.relations.length} 关系`);
        
        await calculateStats(graph, memoryPath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.error(`❌ 文件不存在: ${memoryPath}`);
            process.exit(1);
        }
        console.error('❌ 错误:', error.message);
        process.exit(1);
    }
}

main();