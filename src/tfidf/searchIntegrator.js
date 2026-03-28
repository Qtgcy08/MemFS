/**
 * Search Integrator
 * Main integration point for all search modules
 */

import { HybridSearchService } from './hybridSearchService.js';
import { TraditionalSearcher } from './traditionalSearch.js';

/**
 * Search Integrator
 * Routes search requests to appropriate search mode
 */
export class SearchIntegrator {
    constructor(knowledgeGraphManager) {
        this.manager = knowledgeGraphManager;
        this.hybridService = new HybridSearchService({
            bm25Weight: 0.7,    // Primary sorting
            fuzzyWeight: 0.3,     // Secondary support
            limit: 15,            // Default: 15 results
            minScore: 0.1,
            fuzzyThreshold: 0.1  // Very strict to avoid false positives
        });
        this.traditionalSearcher = new TraditionalSearcher();

        this.isIndexed = false;
    }

    /**
     * Ensure index is built
     */
    async ensureIndex() {
        if (this.isIndexed) return;

        const graph = await this.manager.loadGraph();
        await this.hybridService.buildIndex(graph.entities, graph.observations);
        this.isIndexed = true;
    }

    /**
     * Main search method
     */
    async searchNode(query, options = {}) {
        const {
            basicFetch = false,  // Default: hybrid search
            time = false,
            limit = 15,          // Default: 15 results
            maxObservationsPerEntity = 5,  // Default: 5 per entity
            includeObservations = true,
            // Hybrid search parameters
            bm25Weight = 0.7,
            fuzzyWeight = 0.3,
            fuzzyThreshold = 0.1,  // Very strict
            minScore = 0.01
        } = options;

        const graph = await this.manager.loadGraph();

        // Mode selection
        if (basicFetch) {
            // Traditional search mode
            const result = this.traditionalSearcher.search(query, graph, {
                time,
                includeObservations,
                maxRelations: 20,
                limit,
                maxObservationsPerEntity
            });

            // 保留 TraditionalSearcher 返回的 _meta，仅更新 timestamp
            return {
                searchMode: 'traditional',
                _meta: {
                    ...result._meta,
                    timestamp: new Date().toISOString()
                },
                ...result
            };
        }

        // Hybrid search mode
        await this.ensureIndex();

        const result = this.hybridService.search(query, {
            limit,
            minScore,
            bm25Weight,
            fuzzyWeight,
            fuzzyThreshold
        });

        // Convert to standard return format - 只返回排序后的实体名列表
        const entityNames = result.results.map(r => r.entityName);

        // Get full entity info - 严格基于 entityNames，不额外过滤
        const matchedEntities = entityNames
            .map(name => graph.entities.find(e => e.name === name))
            .filter(Boolean);

        // Get related relations
        // Limit relations to 2x limit to keep output manageable
        const cleanRelations = graph.relations
            .filter(r =>
                entityNames.includes(r.from) &&
                entityNames.includes(r.to)
            )
            .slice(0, limit * 2)
            .map(r => ({
                from: r.from,
                to: r.to,
                relationType: r.relationType
            }));

        // Step 5: Collect related entities through relations (关联实体推荐)
        // Entities connected to matched entities participate in ranking

        const directEntityNames = new Set(entityNames);  // Directly matched entities

        // Use gram tokens from hybridService.search() for relation matching
        // These are the processed tokens including fullQuery, bigrams, trigrams, etc.
        const queryTerms = result.terms || [];

        // Base score for related entities
        const BASE_RELATED_SCORE = 0.5;
        // Boost score when relation type matches query
        const RELATION_MATCH_BOOST = 1.5;

        // Collect ALL entities connected through relations (regardless of query match)
        const relationConnectedEntities = new Map();

        graph.relations.forEach(r => {
            // Check if relation type matches any gram token
            const relationTypeLower = r.relationType.toLowerCase();
            const relationMatchesQuery = queryTerms.some(term => 
                relationTypeLower.includes(term.toLowerCase())
            );
            const scoreBoost = relationMatchesQuery ? RELATION_MATCH_BOOST : BASE_RELATED_SCORE;

            // If 'from' is directly matched and 'to' is NOT directly matched, add 'to' as related
            if (directEntityNames.has(r.from) && !directEntityNames.has(r.to)) {
                const existing = relationConnectedEntities.get(r.to) || {
                    entityName: r.to,
                    relatedScore: 0,
                    relationMatchCount: 0,
                    relatedThrough: []
                };

                existing.relatedScore = Math.max(existing.relatedScore, scoreBoost);
                existing.relatedThrough.push({
                    from: r.from,
                    relationType: r.relationType,
                    matched: relationMatchesQuery
                });

                relationConnectedEntities.set(r.to, existing);
            }

            // If 'to' is directly matched and 'from' is NOT directly matched, add 'from' as related
            if (directEntityNames.has(r.to) && !directEntityNames.has(r.from)) {
                const existing = relationConnectedEntities.get(r.from) || {
                    entityName: r.from,
                    relatedScore: 0,
                    relationMatchCount: 0,
                    relatedThrough: []
                };

                existing.relatedScore = Math.max(existing.relatedScore, scoreBoost);
                existing.relatedThrough.push({
                    to: r.to,
                    relationType: r.relationType,
                    matched: relationMatchesQuery
                });

                relationConnectedEntities.set(r.from, existing);
            }
        });

        // Merge relation-connected entities into final results
        const finalRelatedEntities = Array.from(relationConnectedEntities.values())
            .sort((a, b) => b.relatedScore - a.relatedScore);

        // Return entities in relevance order (LLM注意力头自动处理)
        // Related entities are appended after directly matched entities
        const sortedDirectEntities = entityNames
            .map(name => matchedEntities.find(e => e.name === name))
            .filter(Boolean)
            .map(entity => ({
                name: entity.name,
                entityType: entity.entityType,
                definition: entity.definition || "",
                definitionSource: entity.definitionSource === undefined || entity.definitionSource === null ? null : String(entity.definitionSource),
                observationIds: entity.observationIds || []
            }));

        // Get full entity info for related entities
        // IMPORTANT: Look up from graph.entities, NOT matchedEntities
        // Because related entities are NOT in matchedEntities
        const sortedRelatedEntities = finalRelatedEntities
            .map(related => {
                const entity = graph.entities.find(e => e.name === related.entityName);
                return entity ? {
                    name: entity.name,
                    entityType: entity.entityType,
                    definition: entity.definition || "",
                    definitionSource: entity.definitionSource === undefined || entity.definitionSource === null ? null : String(entity.definitionSource),
                    observationIds: entity.observationIds || [],
                    _related: {
                        relatedThrough: related.relatedThrough
                    }
                } : null;
            })
            .filter(Boolean);

        // Combine: directly matched entities first, then related entities
        // 限制总实体数为 limit，避免关联实体无限追加
        const sortedEntities = [...sortedDirectEntities, ...sortedRelatedEntities].slice(0, limit);

        // Get matched observations (from both direct and related entities)
        let matchedObservations = [];
        if (includeObservations) {
            const obsContentMap = new Map();
            graph.observations.forEach(obs => {
                obsContentMap.set(obs.id, obs.content);
            });

            // Tokenize query for observation scoring
            const queryTerms = query.toLowerCase().split(/\s+/).filter(k => k.length >= 2);

            // Create entity name to score map from hybrid search results
            const entityScoreMap = new Map();
            result.results.forEach(r => {
                entityScoreMap.set(r.entityName, r.finalScore || 0);
            });

            // Score and collect observations by relevance
            const scoredObservations = [];
            
            // All entities to collect observations from (direct + related)
            const allEntitiesForObs = [...matchedEntities];
            
            // Add related entities with their scores
            sortedRelatedEntities.forEach(entity => {
                if (!entityScoreMap.has(entity.name)) {
                    entityScoreMap.set(entity.name, 0.5);
                }
                allEntitiesForObs.push(entity);
            });
            
            allEntitiesForObs.forEach(entity => {
                const entityScore = entityScoreMap.get(entity.name) || 0;
                const entityObs = (entity.observationIds || []).slice(0, maxObservationsPerEntity);
                entityObs.forEach(id => {
                    const obs = graph.observations.find(o => o.id === id);
                    const content = obsContentMap.get(id);
                    if (obs && content) {
                        // Calculate relevance: matching terms ratio * entity score (aggregate score)
                        const matchedTerms = queryTerms.filter(term => 
                            content.toLowerCase().includes(term)
                        ).length;
                        const termRatio = queryTerms.length > 0 ? matchedTerms / queryTerms.length : 0;
                        
                        // Aggregate score = term matching ratio × entity relevance
                        const aggregateScore = termRatio * entityScore;
                        
                        scoredObservations.push({
                            id,
                            obs,
                            aggregateScore,
                            termRatio
                        });
                    }
                });
            });

            // Sort by aggregate score (entity relevance × term matching)
            scoredObservations.sort((a, b) => {
                if (b.aggregateScore !== a.aggregateScore) return b.aggregateScore - a.aggregateScore;
                // Secondary: more matching terms first
                return b.termRatio - a.termRatio;
            });

            // Total observations limit = limit × maxObservationsPerEntity
            const totalObsLimit = limit * maxObservationsPerEntity;

            // Take top totalObsLimit observations
            matchedObservations = scoredObservations
                .slice(0, totalObsLimit)
                .map(item => ({
                    id: item.id,
                    content: item.obs.content,
                    createdAt: time ? (item.obs.createdAt || null) : null,
                    updatedAt: time ? (item.obs.updatedAt || null) : null
                }));
        }

        return {
            entities: sortedEntities,
            relations: cleanRelations,
            observations: matchedObservations,
            _meta: {
                query,
                fullQuery: result.fullQuery,
                terms: result.terms,
                totalCandidates: result.stats.totalCandidates + (result.stats.totalCandidates - directEntityNames.size),
                returnedCount: result.stats.returnedCount,
                relatedEntitiesCount: sortedRelatedEntities.length,
                bm25Weight,
                fuzzyWeight,
                minScore: result.stats.minScore,
                limit,
                indexStatus: this.isIndexed ? 'ready' : 'rebuilding',
                rebuildScheduled: this._rebuildScheduled || false,
                timestamp: new Date().toISOString(),
                tokenization: result.debug?.tokenization || []
            }
        };
    }

    /**
     * Rebuild index - schedules background rebuild, doesn't block
     */
    rebuildIndex() {
        // Mark as needing rebuild
        this.isIndexed = false;
        this.hybridService.isIndexed = false;
        
        // Don't await - rebuild in background
        this._scheduleRebuild();
    }

    /**
     * Schedule background rebuild with debounce
     */
    _scheduleRebuild() {
        if (this._rebuildScheduled) return;
        this._rebuildScheduled = true;
        
        setTimeout(async () => {
            try {
                await this.ensureIndex();
                console.error('[MCP Server] Search index rebuilt');
            } catch (e) {
                console.error('[MCP Server] Index rebuild failed:', e.message);
            } finally {
                this._rebuildScheduled = false;
            }
        }, 100);
    }

    /**
     * Get search service status
     */
    getStatus() {
        return {
            hybridStatus: this.hybridService.getStatus(),
            isIndexed: this.isIndexed
        };
    }
}
