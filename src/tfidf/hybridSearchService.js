/**
 * Hybrid Search Service
 * Combines BM25 + Fuse.js with weighted fusion
 * Supports: query tokenization → individual search → aggregation → deduplication
 */

import { NaturalTfIdfSearcher } from './naturalSearch.js';
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
 * Check if text is primarily Chinese
 * @param {string} text - Input text
 * @returns {boolean} True if text is primarily Chinese
 */
function isChineseText(text) {
    if (!text || typeof text !== 'string') {
        return false;
    }
    // Count Chinese characters (Unicode range for Chinese)
    const chineseChars = text.match(/[\u4e00-\u9fa5]/g) || [];
    // Check if Chinese characters are at least 50% of non-whitespace chars
    const nonWhitespace = text.replace(/\s/g, '');
    if (nonWhitespace.length === 0) return false;
    return (chineseChars.length / nonWhitespace.length) >= 0.5;
}

/**
 * Tokenize query using n-gram sliding window
 * Supports mixed-language content (Chinese, English, etc.)
 * CRITICAL: Always includes full query term for exact matching with higher weight
 * @param {string} query - Search query
 * @returns {object} { tokens: string[], fullQuery: string }
 */
function tokenizeQuery(query) {
    if (!query || typeof query !== 'string') {
        return { tokens: [], fullQuery: '' };
    }

    const tokens = new Set();

    // CRITICAL: Always add full query term FIRST for exact matching
    // This enables high-weight exact matching in applyFusion
    const fullQuery = query.trim();
    if (fullQuery.length >= 2) {
        tokens.add(fullQuery);
    }

    // Step 1: Split by whitespace for multiple query terms
    const whitespaceTokens = query.split(/\s+/).filter(t => t.length > 0);

    whitespaceTokens.forEach(token => {
        // Skip if this is the full query (already added)
        if (token === fullQuery) return;

        // Step 2: Add token for matching
        tokens.add(token);

        // Step 3: Generate n-grams based on text type
        const isChinese = isChineseText(token);

        if (isChinese) {
            if (token.length >= 2) {
                const bigrams = generateNGram(token, 2);
                bigrams.forEach(t => tokens.add(t));
            }
        } else {
            if (token.length >= 3) {
                const trigrams = generateNGram(token, 3);
                trigrams.forEach(t => tokens.add(t));
            }
        }

        // Step 4: 4-gram and 5-gram for longer substring matching
        if (token.length >= 4) {
            const fourgrams = generateNGram(token, 4);
            fourgrams.forEach(t => tokens.add(t));
        }

        if (token.length >= 5) {
            const fivegrams = generateNGram(token, 5);
            fivegrams.forEach(t => tokens.add(t));
        }
    });

    return {
        tokens: Array.from(tokens).filter(t => t.length >= 2),
        fullQuery
    };
}

/**
 * Hybrid Search Service
 * Weighted fusion of TF-IDF and fuzzy search with tokenization support
 */
export class HybridSearchService {
    constructor(options = {}) {
        this.tfidfSearcher = new NaturalTfIdfSearcher({
            fieldWeights: {
                'name': 3.0,
                'entityType': 2.0,
                'definition': 2.0,
                'observation': 2.0
            }
        });

        this.fuseSearcher = new FuseSearcher({
            threshold: options.fuzzyThreshold || 0.1  // Very strict: only allow minimal fuzziness
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
      */
    searchTerm(term) {
        const tfidfResults = this.tfidfSearcher.search(term, { topK: 50 });

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
     * CRITICAL: Full query matches get higher weight in addEntityScore
     */
    aggregateResults(termResults, fullQuery) {
        // Collect all entity scores
        const entityScores = new Map();

        termResults.forEach(({ term, tfidfResults, fuseResults, isFullQuery }) => {
            // Process TF-IDF results
            tfidfResults.forEach(result => {
                if (result.score > 0) {
                    // Full query matches get 2x weight
                    const weightMultiplier = isFullQuery ? 2.0 : 1.0;
                    this.addEntityScore(entityScores, result, term, 'tfidf', weightMultiplier);
                }
            });

            // Process Fuse results
            fuseResults.forEach(result => {
                if (result.score > 0) {
                    // Full query matches get 2x weight
                    const weightMultiplier = isFullQuery ? 2.0 : 1.0;
                    this.addEntityScore(entityScores, result, term, 'fuse', weightMultiplier);
                }
            });
        });

        return entityScores;
    }

    /**
     * Add entity score to aggregation
     * CRITICAL: weightMultiplier allows full query to have higher weight
     */
    addEntityScore(entityScores, result, term, source, weightMultiplier = 1.0) {
        const { entityName, normalizedScore, matchedFields } = result;

        if (!entityScores.has(entityName)) {
            entityScores.set(entityName, {
                entityName,
                totalScore: 0,
                tfidfScore: 0,
                fuzzyScore: 0,
                matchedTerms: new Set(),
                matchedFields: new Map(),
                fullQueryMatch: false  // Track if full query matched
            });
        }

        const entry = entityScores.get(entityName);

        // Apply weight multiplier for full query matches
        const weightedScore = normalizedScore * weightMultiplier;

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
            fieldEntry.score = Math.max(fieldEntry.score, field.score * weightMultiplier);
        });
    }

    /**
     * Apply weighted fusion and sorting
     * CRITICAL: Full query matches get additional boost
     */
    applyFusion(entityScores, bm25Weight, fuzzyWeight, fullQuery) {
        const results = [];

        // Pre-calculate full query boost
        const FULL_QUERY_BOOST = 1.5;  // Additional boost for full query matches

        entityScores.forEach(entry => {
            // Apply weighted fusion
            const finalScore =
                bm25Weight * entry.tfidfScore +
                fuzzyWeight * entry.fuzzyScore;

            // Boost for matching multiple terms
            const termBoost = Math.log2(1 + entry.matchedTerms.size);

            // Additional boost if full query matched
            const fullQueryBoost = entry.fullQueryMatch ? FULL_QUERY_BOOST : 1.0;

            const finalBoostedScore = finalScore * termBoost * fullQueryBoost;

            results.push({
                entityName: entry.entityName,
                score: finalBoostedScore,
                tfidfScore: entry.tfidfScore,
                fuzzyScore: entry.fuzzyScore,
                matchedTerms: Array.from(entry.matchedTerms),
                matchedFields: Array.from(entry.matchedFields.values()),
                fullQueryMatch: entry.fullQueryMatch
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
        const { tokens, fullQuery } = tokenizeQuery(query);

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
        const termResults = tokens.map(term => ({
            term,
            isFullQuery: term === fullQuery,  // Mark if this is the full query
            ...this.searchTerm(term)
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
                }))
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
