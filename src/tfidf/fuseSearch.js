/**
 * Fuse.js Fuzzy Search Module
 * Handles fuzzy matching for typo tolerance
 */

import Fuse from 'fuse.js';

/**
 * Fuse.js Fuzzy Searcher
 * Provides fuzzy matching capabilities
 */
export class FuseSearcher {
    constructor(options = {}) {
        this.fuse = null;

        this.options = {
            includeScore: true,
            threshold: options.threshold || 0.4,  // Lower sensitivity for better results
            keys: [
                { name: 'name', weight: 3.0 },
                { name: 'entityType', weight: 2.0 },
                { name: 'definition', weight: 2.0 },
                { name: 'observations', weight: 2.0 }
            ],
            ...options
        };
    }

    /**
     * Build index from entities and observations
     */
    buildIndex(entities, observations) {
        // Build observation content lookup
        const obsContentMap = new Map();
        observations.forEach(obs => {
            obsContentMap.set(obs.id, obs.content);
        });

        const documents = entities.map(entity => {
            const obsContents = (entity.observationIds || [])
                .map(id => obsContentMap.get(id))
                .filter(Boolean)
                .join(' ');

            return {
                name: entity.name,
                entityType: entity.entityType || '',
                definition: entity.definition || '',
                observations: obsContents,
                original: entity
            };
        });

        this.fuse = new Fuse(documents, this.options);
    }

    /**
     * Search using fuzzy matching
     */
    search(query, options = {}) {
        if (!this.fuse) {
            throw new Error('Index not built. Call buildIndex() first.');
        }

        const { topK = 100 } = options;

        const results = this.fuse.search(query)
            .slice(0, topK)
            .map(r => {
                // Fuse.js: smaller score is better, invert for consistency
                const invertedScore = 1 - r.score;

                return {
                    entityName: r.item.name,
                    score: invertedScore,
                    normalizedScore: 0, // To be normalized
                    matchedFields: this.extractMatchedFields(r)
                };
            });

        // Normalize
        const maxScore = Math.max(...results.map(r => r.score), 0.001);
        results.forEach(r => {
            r.normalizedScore = r.score / maxScore;
        });

        return results;
    }

    /**
     * Extract matched fields from Fuse result
     */
    extractMatchedFields(fuseResult) {
        const fields = [];
        const { matches = [] } = fuseResult;

        matches.forEach(match => {
            if (!fields.some(f => f.field === match.key)) {
                fields.push({
                    field: match.key,
                    score: 1 - match.score
                });
            }
        });

        return fields;
    }

    /**
     * Get statistics
     */
    getStats() {
        return {
            threshold: this.options.threshold,
            keys: this.options.keys
        };
    }
}
