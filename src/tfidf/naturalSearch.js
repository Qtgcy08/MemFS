/**
 * BM25 Search Module
 * Pure JavaScript implementation for better Chinese/foreign language support
 * No dependency on external libraries
 * 
 * BM25 (Best Matching 25) is a ranking function used in information retrieval
 * Formula: score = Σ IDF(qi) × (f(qi,D) × (k1+1)) / (f(qi,D) + k1 × (1-b + b×|D|/avgdl))
 */

/**
 * Generate n-gram tokens from a string
 * @param {string} str - Input string
 * @param {number} n - N-gram size
 * @returns {string[]} Array of n-gram tokens
 */
function generateNGram(str, n) {
    if (str.length < n) {
        return [];  // Don't return single chars as n-gram
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
 * Tokenize text for BM25 indexing
 * Uses n-gram for better Chinese/foreign language support
 * @param {string} text - Input text
 * @returns {string[]} Tokenized terms
 */
function tokenizeForIndex(text) {
    if (!text || typeof text !== 'string') {
        return [];
    }

    const tokens = new Set();

    // Always add full text for exact matching
    tokens.add(text);

    // Check if text is primarily Chinese
    const isChinese = isChineseText(text);

    if (isChinese) {
        // For Chinese text, use 2-gram for word matching
        if (text.length >= 2) {
            const bigrams = generateNGram(text, 2);
            bigrams.forEach(t => tokens.add(t));
        }
    } else {
        // For English/text, start with 3-gram
        if (text.length >= 3) {
            const trigrams = generateNGram(text, 3);
            trigrams.forEach(t => tokens.add(t));
        }
    }

    // Add 4-gram and 5-gram for longer substring matching
    if (text.length >= 4) {
        const fourgrams = generateNGram(text, 4);
        fourgrams.forEach(t => tokens.add(t));
    }

    if (text.length >= 5) {
        const fivegrams = generateNGram(text, 5);
        fivegrams.forEach(t => tokens.add(t));
    }

    return Array.from(tokens);
}

/**
 * BM25 standard parameters
 * k1: term frequency saturation parameter (typical value: 1.2-2.0)
 * b: document length normalization parameter (typical value: 0.75)
 */
const BM25_K1 = 1.2;  // Reduced from 1.5 - less sensitive to term frequency
const BM25_B = 0.5;   // Reduced from 0.75 - reduce length normalization impact

/**
 * BM25 implementation that handles n-grams directly
 */
export class NaturalTfIdfSearcher {
    constructor(options = {}) {
        this.documents = new Map(); // docId -> { entityName, field, content, tokens: Set }
        this.docIdToIndex = new Map(); // docId -> numeric index
        this.indexToDocId = []; // numeric index -> docId
        this.entityIndex = new Map(); // entityName -> Set of docIds

        // Inverted index: token -> { docId -> count }
        this.invertedIndex = new Map(); // token -> Map(docId -> count)

        // Document frequency: token -> number of documents containing token
        this.docFrequency = new Map(); // token -> count

        // Total number of documents
        this.totalDocs = 0;
        
        // BM25 specific: document lengths for length normalization
        this.docLengths = new Map(); // docId -> token count
        this.avgDocLength = 0;       // Average document length
        
        // Index built flag
        this.indexBuilt = false;

        this.options = {
            // Field weights
            fieldWeights: options.fieldWeights || {
                'name': 3.0,         // Entity name - highest weight
                'entityType': 2.0,   // Entity type
                'definition': 2.0,   // Definition
                'observation': 2.0    // Observation
            },
            ...options
        };
    }

    /**
      * Build index from entities and observations
      */
    buildIndex(entities, observations) {
        // Clear existing index
        this.documents.clear();
        this.docIdToIndex.clear();
        this.indexToDocId = [];
        this.entityIndex.clear();
        this.invertedIndex.clear();
        this.docFrequency.clear();
        this.docLengths.clear();

        // Build observation content lookup
        const obsContentMap = new Map();
        observations.forEach(obs => {
            obsContentMap.set(obs.id, obs.content);
        });

        // Index entity names
        entities.forEach(entity => {
            this._addDocument(entity.name, entity.name, 'name', entity);
        });

        // Index entity types
        entities.forEach(entity => {
            if (entity.entityType) {
                this._addDocument(entity.entityType, entity.name, 'entityType', entity);
            }
        });

        // Index definitions
        entities.forEach(entity => {
            if (entity.definition) {
                this._addDocument(entity.definition, entity.name, 'definition', entity);
            }
        });

        // Index observation content
        entities.forEach(entity => {
            (entity.observationIds || []).forEach(obsId => {
                const content = obsContentMap.get(obsId);
                if (content) {
                    this._addDocument(content, entity.name, 'observation', entity, obsId);
                }
            });
        });

        // Calculate document frequency for each token
        this.invertedIndex.forEach((docMap, token) => {
            this.docFrequency.set(token, docMap.size);
        });

        this.totalDocs = this.indexToDocId.length;
        
        // Calculate BM25-specific statistics
        this._calculateDocLengths();
        
        // Mark index as built (even if empty)
        this.indexBuilt = true;
    }

    /**
      * Add a document to the index
      */
    _addDocument(content, entityName, field, original, observationId = null) {
        const docId = field === 'observation'
            ? `obs:${observationId}`
            : `entity:${entityName}:${field}`;

        const index = this.indexToDocId.length;

        // Generate n-gram tokens
        const tokens = new Set(tokenizeForIndex(content));

        this.documents.set(docId, {
            entityName,
            field,
            original,
            content,
            tokens
        });

        this.docIdToIndex.set(docId, index);
        this.indexToDocId.push(docId);
        this._addToEntityIndex(entityName, docId);

        // Add to inverted index
        tokens.forEach(token => {
            if (!this.invertedIndex.has(token)) {
                this.invertedIndex.set(token, new Map());
            }
            const docMap = this.invertedIndex.get(token);
            docMap.set(docId, (docMap.get(docId) || 0) + 1);
        });
    }

    /**
      * Add document to entity index
      */
    _addToEntityIndex(entityName, docId) {
        if (!this.entityIndex.has(entityName)) {
            this.entityIndex.set(entityName, new Set());
        }
        this.entityIndex.get(entityName).add(docId);
    }

    /**
      * Calculate BM25 score for a token in a document
      * BM25 formula: IDF × (f × (k1+1)) / (f + k1 × (1-b + b×|D|/avgdl))
      */
    _bm25(token, docId) {
        const doc = this.documents.get(docId);
        if (!doc || !doc.tokens.has(token)) {
            return 0;
        }

        // Term frequency: count of token in this document
        const f = doc.tokens.has(token) ? 1 : 0;

        // Document frequency: number of documents containing token
        const df = this.docFrequency.get(token) || 1;

        // IDF: log((N - df + 0.5) / (df + 0.5))
        const idf = Math.log((this.totalDocs - df + 0.5) / (df + 0.5));

        // Document length
        const docLength = this.docLengths.get(docId) || 1;

        // BM25 scoring with saturation and length normalization
        const numerator = f * (BM25_K1 + 1);
        const denominator = f + BM25_K1 * (1 - BM25_B + (BM25_B * docLength / this.avgDocLength));

        return idf * (numerator / denominator);
    }

    /**
      * Calculate document lengths for BM25 normalization
      */
    _calculateDocLengths() {
        let totalLength = 0;
        this.documents.forEach((doc, docId) => {
            const length = doc.tokens.size;
            this.docLengths.set(docId, length);
            totalLength += length;
        });
        this.avgDocLength = this.totalDocs > 0 ? totalLength / this.totalDocs : 1;
    }

    /**
      * Legacy method - now uses BM25 internally
      * Kept for backward compatibility
      */
    _tfidf(token, docId) {
        return this._bm25(token, docId);
    }

    /**
      * Search using BM25
      */
    search(query, options = {}) {
        // Index is considered "built" if buildIndex was called (even if empty)
        // We track this via a separate flag instead of checking indexToDocId.length
        if (!this.indexBuilt) {
            throw new Error('Index not built. Call buildIndex() first.');
        }

        const { topK = 100 } = options;

        // Generate n-gram tokens for query
        const queryTokens = new Set(tokenizeForIndex(query.toLowerCase()));

        if (queryTokens.size === 0) {
            return [];
        }

        // Calculate scores for each entity
        const entityScores = new Map();

        this.entityIndex.forEach((docIds, entityName) => {
            let totalScore = 0;
            const fieldScores = new Map();

            // Calculate BM25 for each query token across all docs of this entity
            docIds.forEach(docId => {
                const doc = this.documents.get(docId);
                if (!doc) return;

                const field = doc.field;
                let docScore = 0;

                queryTokens.forEach(token => {
                    docScore += this._bm25(token, docId);
                });

                // Only add this field's contribution if it actually has matches
                if (docScore > 0) {
                    // Apply field weight
                    const weight = this.options.fieldWeights[field] || 1.0;
                    const weightedScore = docScore * weight;
                    totalScore += weightedScore;

                    if (!fieldScores.has(field)) {
                        fieldScores.set(field, { field, score: 0 });
                    }
                    fieldScores.get(field).score += weightedScore;
                }
            });

            if (totalScore > 0) {
                entityScores.set(entityName, {
                    entityName,
                    totalScore,
                    fieldScores: Array.from(fieldScores.values())
                });
            }
        });

        // Normalize scores
        const maxScore = Math.max(
            ...Array.from(entityScores.values()).map(e => e.totalScore),
            0.001
        );

        const normalizedResults = Array.from(entityScores.values())
            .map(entry => ({
                entityName: entry.entityName,
                score: entry.totalScore,
                normalizedScore: entry.totalScore / maxScore,
                matchedFields: entry.fieldScores.map(f => ({
                    field: f.field,
                    score: f.score
                }))
            }))
            .sort((a, b) => b.score - a.score);

        return normalizedResults.slice(0, topK);
    }

    /**
      * Get index statistics
      */
    getStats() {
        return {
            totalDocuments: this.documents.size,
            totalTokens: this.invertedIndex.size,
            avgDocLength: this.avgDocLength,
            fieldWeights: this.options.fieldWeights
        };
    }
}
