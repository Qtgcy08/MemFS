/**
 * Traditional Search Module
 * Preserves existing keyword matching logic for backward compatibility
 */

/**
 * Traditional Searcher
 * Maintains existing search behavior for basicFetch=true
 */
export class TraditionalSearcher {
    constructor(options = {}) {
        this.options = {
            maxRelations: options.maxRelations || 20,
            maxEntities: options.maxEntities || 15,      // 默认限制实体数量
            maxObservations: options.maxObservations || 30, // 默认限制观察总数
            maxObservationsPerEntity: options.maxObservationsPerEntity || 5, // 每个实体最多返回的观察数
            ...options
        };
    }

    /**
     * Search using traditional keyword matching
     */
    search(query, graph, options = {}) {
        const {
            time = false,
            includeObservations = true,
            limit = 15  // 最大实体数量
        } = options;

        const { maxEntities, maxObservations, maxObservationsPerEntity } = this.options;

        // Parse keywords
        const keywords = query.split(/\s+/).filter(k => k.length >= 2);

        // Create observation content lookup
        const obsContentMap = new Map();
        graph.observations.forEach(obs => {
            obsContentMap.set(obs.id, obs.content);
        });

        // Helper: check if content contains any keyword
        const containsKeyword = (content) => {
            if (!content) return false;
            return keywords.some(kw => content.toLowerCase().includes(kw.toLowerCase()));
        };

        // Filter entities by relevance
        const relevantEntities = [];
        const entityObservationMap = new Map();

        for (const entity of graph.entities) {
            let isRelevant = false;
            const relevantObsIds = [];

            // Check entity name
            if (keywords.some(kw => entity.name.toLowerCase().includes(kw.toLowerCase()))) {
                isRelevant = true;
            }

            // Check entityType
            if (!isRelevant && entity.entityType &&
                keywords.some(kw => entity.entityType.toLowerCase().includes(kw.toLowerCase()))) {
                isRelevant = true;
            }

            // Check definition
            if (!isRelevant && entity.definition &&
                keywords.some(kw => (entity.definition || "").toLowerCase().includes(kw.toLowerCase()))) {
                isRelevant = true;
            }

            // Check observations - only set isRelevant if observations contain keywords
            const entityObs = (entity.observationIds || [])
                .map(id => ({ id, content: obsContentMap.get(id) }))
                .filter(o => o.content !== undefined);

            for (const obs of entityObs) {
                if (containsKeyword(obs.content)) {
                    if (!isRelevant) isRelevant = true;
                    relevantObsIds.push(obs.id);
                }
            }

            // Only add to relevantEntities if isRelevant is true (from name, type, def, or observations)
            if (isRelevant) {
                relevantEntities.push(entity);
                entityObservationMap.set(entity.name, relevantObsIds);
            }
        }

        // Collect relevant observations
        const relevantObservationIds = new Set();
        relevantEntities.forEach(entity => {
            const obs = (entity.observationIds || []).map(id => ({ id, content: obsContentMap.get(id) }));
            for (const o of obs) {
                if (containsKeyword(o.content)) {
                    relevantObservationIds.add(o.id);
                }
            }
        });

        const relevantObservations = Array.from(relevantObservationIds)
            .map(id => {
                const obs = graph.observations.find(o => o.id === id);
                return obs ? {
                    id: obs.id,
                    content: obs.content,
                    createdAt: time ? (obs.createdAt || null) : null
                } : null;
            })
            .filter(o => o !== null);

        // Filter relations
        const cleanRelations = graph.relations
            .filter(r =>
                relevantEntities.some(e => e.name === r.from) &&
                relevantEntities.some(e => e.name === r.to)
            )
            .slice(0, this.options.maxRelations)
            .map(r => ({
                from: r.from,
                to: r.to,
                relationType: r.relationType
            }));

        // Limit entities to 'limit' parameter (default 15)
        const limitedEntities = relevantEntities.slice(0, limit);

        // Collect observation IDs from limited entities only, score by term matching
        const limitedObservationIds = new Set();
        const scoredEntityObs = [];
        limitedEntities.forEach((entity, entityIndex) => {
            const entityObs = (entity.observationIds || [])
                .slice(0, maxObservationsPerEntity); // 每个实体最多 maxObservationsPerEntity 个观察
            entityObs.forEach(id => {
                const content = obsContentMap.get(id);
                if (content && containsKeyword(content)) {
                    // Score: earlier entities in relevance list get higher score
                    // Aggregate score = (1 - entityIndex / total) × term matching ratio
                    const matchedTerms = keywords.filter(kw => 
                        content.toLowerCase().includes(kw.toLowerCase())
                    ).length;
                    const termRatio = keywords.length > 0 ? matchedTerms / keywords.length : 0;
                    const entityWeight = 1 - (entityIndex / (limitedEntities.length || 1));
                    const aggregateScore = termRatio * entityWeight;

                    scoredEntityObs.push({
                        id,
                        aggregateScore,
                        termRatio,
                        entityIndex
                    });
                }
            });
        });

        // Sort by aggregate score
        scoredEntityObs.sort((a, b) => {
            if (b.aggregateScore !== a.aggregateScore) return b.aggregateScore - a.aggregateScore;
            return b.termRatio - a.termRatio;
        });

        // Total observations limit = limit × maxObservationsPerEntity
        const totalObsLimit = limit * maxObservationsPerEntity;

        // Take top totalObsLimit observations
        const limitedObsArray = scoredEntityObs
            .slice(0, totalObsLimit)
            .map(item => item.id);

        // Build observation content lookup for limited entities
        const limitedObsContentMap = new Map();
        limitedObsArray.forEach(id => {
            const obs = graph.observations.find(o => o.id === id);
            if (obs) {
                limitedObsContentMap.set(id, obs.content);
            }
        });

        // Clean observations - only those from limited entities
        const cleanedObservations = limitedObsArray
            .map(id => {
                const obs = graph.observations.find(o => o.id === id);
                return obs ? {
                    id: obs.id,
                    content: obs.content,
                    createdAt: time ? (obs.createdAt || null) : null
                } : null;
            })
            .filter(o => o !== null);

        // Clean entities
        const cleanedEntities = limitedEntities.map(entity => ({
            name: entity.name,
            entityType: entity.entityType,
            definition: entity.definition || "",
            definitionSource: entity.definitionSource === undefined || entity.definitionSource === null ? null : String(entity.definitionSource),
            observationIds: entity.observationIds || []
        }));

        return {
            entities: cleanedEntities,
            relations: cleanRelations,
            observations: cleanedObservations,
            searchMode: 'traditional',
            _meta: {
                basicFetch: true,
                totalCandidates: relevantEntities.length,
                returnedCount: cleanedEntities.length,
                bm25Weight: 0,
                fuzzyWeight: 0,
                timestamp: new Date().toISOString()
            }
        };
    }
}
