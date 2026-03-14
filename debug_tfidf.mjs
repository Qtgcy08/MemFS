#!/usr/bin/env node
/**
 * Debug TF-IDF indexing for Chinese
 */

import { KnowledgeGraphManager } from './index.js';
import { NaturalTfIdfSearcher } from './src/tfidf/bm25Search.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function test() {
    const timestamp = Date.now();
    const memoryPath = path.join(__dirname, '.test_tfidf_' + timestamp + '.jsonl');
    const manager = new KnowledgeGraphManager(memoryPath);
    const searcher = new NaturalTfIdfSearcher({});

    // Create test data
    const entities = [
        {
            name: "TypeScript",
            entityType: "language",
            definition: "JavaScript的超集，添加了静态类型系统和面向对象特性",
            observations: ["由微软开发", "编译为纯JavaScript", "类型安全"]
        }
    ];

    await manager.createEntity(entities);

    // Debug: Check what's in observations
    const graph = await manager.listGraph();
    console.log('Observations:');
    graph.observations.forEach(obs => {
        console.log(`  ID ${obs.id}: "${obs.content}"`);
    });

    // Build index
    await searcher.buildIndex(graph.entities, graph.observations);

    // Check what's indexed
    console.log('\nIndexed documents:');
    searcher.documents.forEach((doc, docId) => {
        console.log(`  ${docId}: ${doc.field}, tokens: ${Array.from(doc.tokens).slice(0, 5).join(', ')}...`);
    });

    // Check inverted index for "微软"
    console.log('\nInverted index for "微软":');
    if (searcher.invertedIndex.has('微软')) {
        console.log(`  Found! Docs: ${Array.from(searcher.invertedIndex.get('微软').keys()).join(', ')}`);
    } else {
        console.log('  Not found in inverted index');
    }

    // Check inverted index for "微"
    console.log('\nInverted index for "微":');
    if (searcher.invertedIndex.has('微')) {
        console.log(`  Found! Docs: ${Array.from(searcher.invertedIndex.get('微').keys()).join(', ')}`);
    } else {
        console.log('  Not found in inverted index');
    }

    // Search for "微软"
    console.log('\nSearch for "微软":');
    const results = searcher.search("微软");
    console.log(`  Results: ${results.length}`);
    results.forEach(r => {
        console.log(`  ${r.entityName}: ${r.score.toFixed(4)}`);
    });

    // Search for "xyz123nonexistent"
    console.log('\nSearch for "xyz123nonexistent":');
    const results2 = searcher.search("xyz123nonexistent");
    console.log(`  Results: ${results2.length}`);
    results2.forEach(r => {
        console.log(`  ${r.entityName}: ${r.score.toFixed(4)}`);
    });

    // Cleanup
    try {
        await fs.unlink(memoryPath);
    } catch (e) {}
}

test().catch(console.error);
