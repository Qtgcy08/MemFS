/**
 * Hybrid Search Service
 * Combines BM25 + Fuse.js with weighted fusion
 * Supports: query tokenization → individual search → aggregation → deduplication
 */

import { NaturalTfIdfSearcher } from './bm25Search.js';
import { FuseSearcher } from './fuseSearch.js';

/**
 * Generate n-gram tokens from a string
 * @param {string} str - Input string
 * @param {number} n - N-gram size
 * @returns {string[]} Array of n-gram tokens
 */
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

/**
 * 清洗文本：去除符号和空格，统一匹配基础
 * @param {string} text - Input text
 * @returns {string} Cleaned text
 */
function cleanText(text) {
    if (!text || typeof text !== 'string') {
        return '';
    }
    return text
        .replace(/[\u3000-\u303f\uff00-\uffef!@#$%^&*()=\[\]{}|;':",.\/<>?`~\\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * 计算 n-gram 惩罚系数
 * 长度越长，权重越低，避免长串主导匹配
 * 2-gram 也施加 penalty，避免假阳性匹配（如 "CA" 匹配无关内容）
 * @param {number} n - N-gram size
 * @returns {number} Penalty coefficient
 */
function getGramPenalty(n) {
    if (n === 2) {
        return 0.5;  // 2-gram: 50% penalty，减少假阳性
    }
    return 1 / Math.pow(Math.E, n - 2);
}

/**
 * 统一切片查询预处理
 * 遵循《苦涩的教训》：通用方法，无语言知识，让计算解决问题
 * @param {string} query - Search query
 * @returns {object} { tokens: string[], fullQuery: string, tokenPenalties: object }
 */
function tokenizeQuery(query) {
    if (!query || typeof query !== 'string') {
        return { tokens: [], fullQuery: '', tokenPenalties: {} };
    }

    // Step 1: 清洗 - 去除符号和空格
    const cleaned = cleanText(query);

    if (!cleaned) {
        return { tokens: [], fullQuery: '', tokenPenalties: {} };
    }

    const tokens = new Set();
    const tokenPenalties = {};
    const fullQuery = cleaned;

    // Step 2: fullQuery 兜底（后续在评分层 boost）
    if (fullQuery.length >= 2) {
        tokens.add(fullQuery);
        tokenPenalties[fullQuery] = 1.0;
    }

    // Step 3: 按空白符分割
    const whitespaceTokens = cleaned.split(/\s+/).filter(t => t.length > 0);

    whitespaceTokens.forEach(token => {
        if (token === fullQuery) return;

        // 原始 token
        tokens.add(token);
        tokenPenalties[token] = 1.0;

        // Step 4: 生成 2~(n-1) gram，最大为 n-1（fullQuery 已是 n-gram）
        for (let n = 2; n <= token.length - 1; n++) {
            generateNGram(token, n).forEach(gram => {
                if (!tokens.has(gram)) {
                    tokens.add(gram);
                    tokenPenalties[gram] = getGramPenalty(n);
                }
            });
        }
    });

    return {
        tokens: Array.from(tokens).filter(t => t.length >= 2),
        fullQuery,
        tokenPenalties
    };
}

/**
 * Hybrid Search Service
 * Weighted fusion of TF-IDF and fuzzy search with tokenization support
 */

// Unified field weights - single source of truth
const DEFAULT_FIELD_WEIGHTS = {
    'name': 5.0,
    'entityType': 2.5,
    'definition': 2.5,
    'definitionSource': 1.5,
    'observation': 1.0
};

export class HybridSearchService {
    constructor(options = {}) {
        const fieldWeights = options.fieldWeights || DEFAULT_FIELD_WEIGHTS;

        this.tfidfSearcher = new NaturalTfIdfSearcher({
            fieldWeights
        });

        // Convert fieldWeights to Fuse.js keys format
        const fuseKeys = Object.entries(fieldWeights).map(([name, weight]) => ({
            name,
            weight
        }));

        this.fuseSearcher = new FuseSearcher({
            threshold: options.fuzzyThreshold || 0.1,  // Very strict
            keys: fuseKeys
        });

        this.options = {
            // Weight distribution
            bm25Weight: options.bm25Weight || options.tfidfWeight || 0.7,  // tfidfWeight for backward compat
            fuzzyWeight: options.fuzzyWeight || 0.3,

            // Return limit
            limit: options.limit || 15,
            minScore: options.minScore || 0.01,

            ...options
        };

        this.isIndexed = false;
        this.lastBuildTime = null;
    }

    /**
     * Build index
     */
    async buildIndex(entities, observations) {
        const startTime = Date.now();

        this.tfidfSearcher.buildIndex(entities, observations);
        this.fuseSearcher.buildIndex(entities, observations);

        this.lastBuildTime = Date.now() - startTime;
        this.isIndexed = true;

        return {
            tfidfStats: this.tfidfSearcher.getStats(),
            fuseStats: this.fuseSearcher.getStats(),
            buildTime: this.lastBuildTime
        };
    }

    /**
      * Search individual term
      * @param {string} term - Search term
      * @param {object} options - Optional: pre-computed tokens and penalties
      * @param {string[]} options.tokens - Pre-tokenized tokens
      * @param {number[]} options.penalties - Penalties for each token
      */
    searchTerm(term, options = {}) {
        const { tokens, penalties } = options;
        
        const searchOptions = { topK: 50 };
        if (tokens) {
            searchOptions.tokens = tokens;
            searchOptions.tokenPenalties = penalties;
        }
        
        const tfidfResults = this.tfidfSearcher.search(term, searchOptions);

        // Skip fuzzy search for very short terms to avoid false positives
        // TF-IDF is more precise for short terms
        let fuseResults = [];
        if (term.length >= 3) {
            fuseResults = this.fuseSearcher.search(term, { topK: 50 });
        }

        return {
            term,
            tfidfResults,
            fuseResults,
            tfidfCount: tfidfResults.length,
            fuseCount: fuseResults.length
        };
    }

    /**
     * Aggregate results from multiple terms
     * CRITICAL: Full query + name match gets 5x weight
     */
    aggregateResults(termResults, fullQuery) {
        // Collect all entity scores
        const entityScores = new Map();

        termResults.forEach(({ term, tfidfResults, fuseResults, isFullQuery, penalty }) => {
            // Process TF-IDF results
            tfidfResults.forEach(result => {
                if (result.score > 0) {
                    this.addEntityScore(entityScores, result, term, 'tfidf', isFullQuery, penalty);
                }
            });

            // Process Fuse results
            fuseResults.forEach(result => {
                if (result.score > 0) {
                    this.addEntityScore(entityScores, result, term, 'fuse', isFullQuery, penalty);
                }
            });
        });

        return entityScores;
    }

    /**
     * Add entity score to aggregation
     * CRITICAL: fullQuery + name match gets 5x weight boost
     * @param {Map} entityScores - Entity scores map
     * @param {object} result - Search result
     * @param {string} term - Matched term
     * @param {string} source - 'tfidf' or 'fuse'
     * @param {boolean} isFullQuery - Whether term is full query
     * @param {number} penalty - Gram penalty (1/e^(n-2))
     */
    addEntityScore(entityScores, result, term, source, isFullQuery = false, penalty = 1.0) {
        const { entityName, normalizedScore, matchedFields } = result;

        if (!entityScores.has(entityName)) {
            entityScores.set(entityName, {
                entityName,
                totalScore: 0,
                tfidfScore: 0,
                fuzzyScore: 0,
                matchedTerms: new Set(),
                matchedFields: new Map(),
                fullQueryMatch: false,
                fullQueryNameMatch: false  // Track if full query matched entity name
            });
        }

        const entry = entityScores.get(entityName);

        // Calculate weight multiplier
        // 5x boost if full query exactly matches entity name
        // 2x boost if full query matches other fields
        // 1x normal weight
        let weightMultiplier = 1.0;
        if (isFullQuery) {
            const nameMatched = matchedFields.some(f => f.field === 'name');
            if (nameMatched) {
                weightMultiplier = 10.0;
                entry.fullQueryNameMatch = true;
            } else {
                weightMultiplier = 2.0;
            }
            entry.fullQueryMatch = true;
        }

        // Apply weight multiplier and gram penalty
        const weightedScore = normalizedScore * weightMultiplier * penalty;

        // Add score based on source
        if (source === 'tfidf') {
            entry.tfidfScore += weightedScore;
        } else {
            entry.fuzzyScore += weightedScore;
        }

        // Track matched terms
        entry.matchedTerms.add(term);

        // Mark if full query matched
        if (weightMultiplier > 1.0) {
            entry.fullQueryMatch = true;
        }

        // Track matched fields
        matchedFields.forEach(field => {
            if (!entry.matchedFields.has(field.field)) {
                entry.matchedFields.set(field.field, {
                    field: field.field,
                    score: 0
                });
            }
            const fieldEntry = entry.matchedFields.get(field.field);
            fieldEntry.score = Math.max(fieldEntry.score, field.score * weightMultiplier * penalty);
        });
    }

    /**
     * Apply weighted fusion and sorting
     * CRITICAL: Full query + name match gets additional 2x boost (total 10x with previous 5x)
     */
    applyFusion(entityScores, bm25Weight, fuzzyWeight, fullQuery) {
        const results = [];

        // Additional boost for full query name match
        const FULL_QUERY_BOOST = 1.5;  // For full query non-name matches (total 3x with previous 2x)
        const FULL_QUERY_NAME_BOOST = 2.0;  // Extra boost for full query + name (total 10x with previous 5x)

        entityScores.forEach(entry => {
            // Apply weighted fusion
            const finalScore =
                bm25Weight * entry.tfidfScore +
                fuzzyWeight * entry.fuzzyScore;

            // Boost for matching multiple terms
            const termBoost = Math.log2(1 + entry.matchedTerms.size);

            // Additional boost if full query matched
            let fullQueryBoost = 1.0;
            if (entry.fullQueryNameMatch) {
                fullQueryBoost = FULL_QUERY_NAME_BOOST;  // 2x extra = total 10x
            } else if (entry.fullQueryMatch) {
                fullQueryBoost = FULL_QUERY_BOOST;  // 1.5x extra = total 3x
            }

            const finalBoostedScore = finalScore * termBoost * fullQueryBoost;

            results.push({
                entityName: entry.entityName,
                score: finalBoostedScore,
                tfidfScore: entry.tfidfScore,
                fuzzyScore: entry.fuzzyScore,
                matchedTerms: Array.from(entry.matchedTerms),
                matchedFields: Array.from(entry.matchedFields.values()),
                fullQueryMatch: entry.fullQueryMatch,
                fullQueryNameMatch: entry.fullQueryNameMatch
            });
        });

        return results;
    }

    /**
     * Hybrid search with tokenization, individual search, and aggregation
     */
    search(query, options = {}) {
        if (!this.isIndexed) {
            throw new Error('Index not built. Call buildIndex() first.');
        }

        const {
            limit = this.options.limit,
            minScore = this.options.minScore,
            bm25Weight = this.options.bm25Weight,
            fuzzyWeight = this.options.fuzzyWeight
        } = options;

        // Step 1: Tokenize query
        const { tokens, fullQuery, tokenPenalties } = tokenizeQuery(query);

        if (tokens.length === 0) {
            return {
                query,
                terms: [],
                results: [],
                stats: {
                    totalCandidates: 0,
                    returnedCount: 0,
                    bm25Weight,
                    fuzzyWeight,
                    limit,
                    minScore
                },
                debug: {
                    tokenization: []
                }
            };
        }

        // Step 2: Search each term individually
        // Pass pre-computed tokens and penalties to BM25 for proper scoring
        const termResults = tokens.map(term => ({
            term,
            isFullQuery: term === fullQuery,  // Mark if this is the full query
            penalty: tokenPenalties[term] || 1.0,  // Apply gram penalty
            ...this.searchTerm(term, {
                tokens: [term],  // Use the single term as token
                penalties: [tokenPenalties[term] || 1.0]
            })
        }));

        // Step 3: Aggregate results
        const entityScores = this.aggregateResults(termResults, fullQuery);

        // Step 4: Apply fusion with full query boost
        const fusedResults = this.applyFusion(entityScores, bm25Weight, fuzzyWeight, fullQuery);

        // Step 5: Filter and limit
        const filteredResults = fusedResults
            .filter(r => r.score >= minScore)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);

        // Step 6: Format output - 只保留实体名，排序由内部完成
        const results = filteredResults.map(r => ({
            entityName: r.entityName
        }));

        return {
            query,
            fullQuery,  // Include full query for debugging
            terms: tokens,  // Tokenized terms
            results,
            stats: {
                totalCandidates: entityScores.size,
                returnedCount: results.length,
                bm25Weight,
                fuzzyWeight,
                limit,
                minScore
            },
            debug: {
                tokenization: termResults.map(tr => ({
                    term: tr.term,
                    isFullQuery: tr.isFullQuery || false,
                    tfidfCount: tr.tfidfCount,
                    fuseCount: tr.fuseCount
                })),
                scoring: {
                    fullQueryNameMatchBoost: '5x base + 2x fusion = 10x total',
                    fullQueryMatchBoost: '2x base + 1.5x fusion = 3x total',
                    normalBoost: '1x'
                }
            }
        };
    }

    /**
     * Get service status
     */
    getStatus() {
        return {
            isIndexed: this.isIndexed,
            lastBuildTime: this.lastBuildTime,
            options: this.options
        };
    }
}
