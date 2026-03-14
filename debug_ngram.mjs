#!/usr/bin/env node
/**
 * Debug test for n-gram matching
 */

import { KnowledgeGraphManager } from './index.js';
import { HybridSearchService } from './src/tfidf/hybridSearchService.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function test() {
    const timestamp = Date.now();
    const memoryPath = path.join(__dirname, '.test_debug_' + timestamp + '.jsonl');
    const manager = new KnowledgeGraphManager(memoryPath);
    const searchIntegrator = new HybridSearchService({});

    // Create test data
    const entities = [
        {
            name: "JavaScript",
            entityType: "language",
            definition: "一种脚本语言，用于Web开发和浏览器端编程",
            observations: ["由Brendan Eich在1995年创建", "广泛用于前端开发", "支持函数式编程"]
        }
    ];

    await manager.createEntity(entities);
    await searchIntegrator.buildIndex(
        (await manager.listGraph()).entities,
        (await manager.listGraph()).observations
    );

    // Test n-gram tokenization
    const query = "xyz123nonexistent";
    const tokens = tokenizeQuery(query);
    console.log('Query:', query);
    console.log('Tokens:', tokens);
    console.log('Token count:', tokens.length);

    // Check if any token matches
    console.log('\nChecking each token against data...');
    tokens.forEach(token => {
        const results = searchIntegrator.searchTerm(token);
        console.log(`  Token "${token}": TF-IDF=${results.tfidfCount}, Fuse=${results.fuseCount}`);
    });

    // Full search
    const fullResults = searchIntegrator.search(query);
    console.log('\nFull search results:', fullResults);

    // Cleanup
    try {
        await fs.unlink(memoryPath);
    } catch (e) {}
}

// Copy the tokenize function
function generateNGram(str, n) {
    if (str.length < n) {
        return str.length > 0 ? [str] : [];
    }
    const tokens = [];
    for (let i = 0; i <= str.length - n; i++) {
        tokens.push(str.substring(i, i + n));
    }
    return tokens;
}

function tokenizeQuery(query) {
    if (!query || typeof query !== 'string') {
        return [];
    }
    const tokens = new Set();
    const whitespaceTokens = query.split(/\s+/).filter(t => t.length > 0);
    whitespaceTokens.forEach(token => {
        if (token.length >= 2) {
            tokens.add(token);
        }
        if (token.length >= 2) {
            const bigrams = generateNGram(token, 2);
            const trigrams = generateNGram(token, 3);
            bigrams.forEach(t => tokens.add(t));
            trigrams.forEach(t => tokens.add(t));
        }
    });
    return Array.from(tokens).filter(t => t.length >= 2);
}

test().catch(console.error);
