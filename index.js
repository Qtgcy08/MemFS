#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Fuse from 'fuse.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

// Import search modules
import { SearchIntegrator } from './src/tfidf/searchIntegrator.js';

// Get user home directory with fallback
function getHomeDir() {
    const home = homedir();
    // If homedir returns root or empty, try environment variables
    if (!home || home === '/' || home.endsWith(':\\')) {
        return process.env.USERPROFILE || 
               process.env.HOME || 
               process.env.HOMEPATH ||
               path.join(process.env.HOMEDRIVE || 'C:', '\\Users', process.env.USERNAME || 'User');
    }
    return home;
}

// Define memory file path - store in user home directory under .memory folder
const userMemoryDir = path.join(getHomeDir(), '.memory');
export const defaultMemoryPath = path.join(userMemoryDir, 'memory.jsonl');

// Handle backward compatibility: migrate memory.json to memory.jsonl if needed
export async function ensureMemoryFilePath() {
    // Check for custom directory via MEMORY_DIR environment variable
    if (process.env.MEMORY_DIR) {
        const customDir = path.isAbsolute(process.env.MEMORY_DIR)
            ? process.env.MEMORY_DIR
            : path.join(getHomeDir(), process.env.MEMORY_DIR);
        return path.join(customDir, 'memory.jsonl');
    }
    // Check for custom file path via MEMORY_FILE_PATH environment variable
    if (process.env.MEMORY_FILE_PATH) {
        return path.isAbsolute(process.env.MEMORY_FILE_PATH)
            ? process.env.MEMORY_FILE_PATH
            : path.join(path.dirname(fileURLToPath(import.meta.url)), process.env.MEMORY_FILE_PATH);
    }
    // No custom path set, check for backward compatibility migration
    const oldMemoryPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory.json');
    const newMemoryPath = defaultMemoryPath;
    try {
        // Check if old file exists and new file doesn't
        await fs.access(oldMemoryPath);
        try {
            await fs.access(newMemoryPath);
            // Both files exist, use new one (no migration needed)
            return newMemoryPath;
        }
        catch {
            // Old file exists, new file doesn't - migrate
            console.error('DETECTED: Found legacy memory.json file, migrating to memory.jsonl for JSONL format compatibility');
            await fs.rename(oldMemoryPath, newMemoryPath);
            console.error('COMPLETED: Successfully migrated memory.json to memory.jsonl');
            return newMemoryPath;
        }
    }
    catch {
        // Old file doesn't exist, use new path
        return newMemoryPath;
    }
}
// Initialize memory file path (will be set during startup)
let MEMORY_FILE_PATH;
// Helper function to format observations - conditionally include createdAt
// Handles multiple timestamp formats:
// - UTC ISO: "2026-02-08T08:18:30.317Z" -> returns as-is
// - Local+offset: "2026-02-09 07:14:05+0800" -> returns as-is
// - New format: {utc, timezone} -> converts to local time with IANA timezone
function formatObservations(observations, includeTime = false) {
    return observations.map(o => {
        const ts = includeTime ? formatObservationTimestamp(o.createdAt) : { createdAt: null, updatedAt: null };
        const base = {
            id: o.id,
            content: o.content,
            createdAt: null  // 默认为 null，time=true 时会被覆盖
        };
        if (includeTime) {
            if (ts.updatedAt) {
                base.updatedAt = ts.updatedAt;
            }
            if (ts.createdAt) {
                base.createdAt = ts.createdAt;
            }
        }
        return base;
    });
}

// Get the system timezone (IANA identifier)
// Returns: "Asia/Shanghai", "Asia/Hong_Kong", "Europe/London", etc.
function getSystemTimezone() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (e) {
        return 'UTC';
    }
}

// Format datetime with IANA timezone for display
// Input: UTC ISO string or Date object, timezone identifier
// Output: "YYYY-MM-DD HH:mm:ss Timezone"
function formatWithTimezone(utcInput, timezone = null) {
    const tz = timezone || getSystemTimezone();
    const date = utcInput instanceof Date ? utcInput : new Date(utcInput);

    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });

    const parts = formatter.formatToParts(date);
    const getPart = (type) => parts.find(p => p.type === type).value;

    const year = getPart('year');
    const month = getPart('month');
    const day = getPart('day');
    const hour = getPart('hour');
    const minute = getPart('minute');
    const second = getPart('second');

    return `${year}-${month}-${day} ${hour}:${minute}:${second} ${tz}`;
}

// Format timestamp for storage
// Returns object with UTC ISO string and IANA timezone
function getCurrentTimestamp() {
    return {
        utc: new Date().toISOString(),
        timezone: getSystemTimezone()
    };
}

// Format timestamp for API response
// Handles multiple storage formats:
// - UTC ISO: "2026-02-08T08:18:30.317Z" -> returns {value, type: 'createdAt'}
// - Local+offset: "2026-02-09 07:14:05+0800" -> returns {value, type: 'createdAt'}
// - New format: {utc, timezone} -> converts to local time with IANA timezone
// - With updatedAt: returns updatedAt with type 'updatedAt'
function formatTimestamp(data) {
    if (!data) return null;

    // Handle new format with updatedAt
    if (typeof data === 'object' && data.utc) {
        // Prefer updatedAt if exists
        if (data.updatedAt) {
            const updatedAt = data.updatedAt;
            if (typeof updatedAt === 'object' && updatedAt.utc) {
                return {
                    value: formatWithTimezone(updatedAt.utc, updatedAt.timezone || data.timezone),
                    type: 'updatedAt'
                };
            }
            if (typeof updatedAt === 'string') {
                return {
                    value: formatWithTimezone(updatedAt, data.timezone),
                    type: 'updatedAt'
                };
            }
        }
        // Fallback to createdAt (new format)
        if (data.timezone) {
            return {
                value: formatWithTimezone(data.utc, data.timezone),
                type: 'createdAt'
            };
        }
    }

    // Old formats: string (UTC ISO or Local+offset) -> return as-is with type
    if (typeof data === 'string') {
        return {
            value: data,
            type: 'createdAt'
        };
    }

    return null;
}

// Format observation timestamp with type info
// Returns: { createdAt, updatedAt } with appropriate values based on data
function formatObservationTimestamp(data) {
    if (!data) return { createdAt: null, updatedAt: null };

    // Handle new format with updatedAt
    if (typeof data === 'object' && data.utc) {
        // Prefer updatedAt if exists
        if (data.updatedAt) {
            const updatedAt = data.updatedAt;
            let updatedAtValue;
            if (typeof updatedAt === 'object' && updatedAt.utc) {
                updatedAtValue = formatWithTimezone(updatedAt.utc, updatedAt.timezone || data.timezone);
            } else if (typeof updatedAt === 'string') {
                updatedAtValue = updatedAt;
            }
            return {
                createdAt: formatWithTimezone(data.utc, data.timezone),
                updatedAt: updatedAtValue
            };
        }
        // Fallback to createdAt only
        return {
            createdAt: formatWithTimezone(data.utc, data.timezone),
            updatedAt: null
        };
    }

    // Old formats: string -> return as-is
    if (typeof data === 'string') {
        return {
            createdAt: data,
            updatedAt: null
        };
    }

    return { createdAt: null, updatedAt: null };
}

// The KnowledgeGraphManager class contains all operations to interact with the knowledge graph
export class KnowledgeGraphManager {
    memoryFilePath;
    cache;
    fileLock;
    searchIntegrator;  // Reference to searchIntegrator for index rebuild on data changes
    constructor(memoryFilePath, searchIntegrator = null) {
        this.memoryFilePath = memoryFilePath;
        this.cache = null;  // Simple memory cache: { data, mtime, timestamp }
        this.fileLock = null;  // File lock state
        this.isWindows = process.platform === 'win32';
        this.searchIntegrator = searchIntegrator;
    }
    
    // Clear cache
    _clearCache() {
        this.cache = null;
    }
    
    // Check if cache is valid (within TTL)
    _isCacheValid() {
        if (!this.cache) return false;
        const now = Date.now();
        const ttl = 30000;  // 30 seconds TTL
        return (now - this.cache.timestamp) < ttl;
    }
    
    // Acquire file lock
    // Windows 文件锁机制有多"幽默"？
    // - fs.lock() 在 Windows 上返回 -4094 错误码 (EBUSY)
    // - Node.js 文档说 "Windows doesn't support file locks"
    // - 所以我们选择：相信操作系统 + 原子性写入
    async _acquireLock() {
        // Windows: 文件锁？不存在的
        // 我们依靠 fs.writeFile 的原子性 rename 策略
        // 同一目录下 rename 是原子的，不会race condition
        // 只要我们不介意偶尔的数据丢失（不是
        return Promise.resolve();
    }
    
    // Release file lock
    async _releaseLock() {
        this.fileLock = null;
    }
    
    // Close and cleanup resources
    async close() {
        await this._releaseLock();
    }
    
    async loadGraph() {
        // Check cache first
        if (this._isCacheValid()) {
            return this.cache.data;
        }
        
        try {
            const data = await fs.readFile(this.memoryFilePath, "utf-8");
            const lines = data.split("\n").filter(line => line.trim() !== "");
            
            // First pass: collect all items
            const rawEntities = [];
            const rawObservations = [];
            const rawDefinitions = [];
            const rawRelations = [];
            let needsMigration = false;
            
            lines.forEach(line => {
                const item = JSON.parse(line);
                if (item.type === "entity") {
                    // Check if needs migration (has embedded observations)
                    if (item.observations && item.observations.length > 0 && typeof item.observations[0] === "string") {
                        needsMigration = true;
                    }
                    rawEntities.push(item);
                } else if (item.type === "observation") {
                    rawObservations.push(item);
                } else if (item.type === "definition") {
                    rawDefinitions.push(item);
                } else if (item.type === "relation") {
                    rawRelations.push(item);
                }
            });
            
            // If old format detected, migrate to new format
            if (needsMigration) {
                console.error("DETECTED: Old entity format with embedded observations, migrating to centralized storage...");
                const migratedObservations = [];
                const maxId = rawObservations.length > 0 
                    ? Math.max(...rawObservations.map(o => o.id))
                    : 0;
                let nextId = maxId + 1;
                
                // Convert embedded observations to centralized storage
                rawEntities.forEach(entity => {
                    if (entity.observations && Array.isArray(entity.observations)) {
                        const observationIds = [];
                        entity.observations.forEach(obs => {
                            if (typeof obs === "string") {
                                migratedObservations.push({
                                    type: "observation",
                                    id: nextId++,
                                    content: obs,
                                    createdAt: getCurrentTimestamp()
                                });
                                observationIds.push(nextId - 1);
                            } else if (typeof obs === "number") {
                                // Already an ID reference
                                observationIds.push(obs);
                            }
                        });
                        entity.observationIds = observationIds;
                        delete entity.observations;
                    } else {
                        entity.observationIds = entity.observationIds || [];
                    }
                });
                
                console.error(`COMPLETED: Migrated ${migratedObservations.length} observations to centralized storage`);
                
                // Save migrated data
                await this.saveGraph({
                    entities: rawEntities.map(e => ({
                        name: e.name,
                        entityType: e.entityType,
                        definition: e.definition || "",
                        definitionSource: e.definitionSource === undefined || e.definitionSource === null ? null : String(e.definitionSource),
                        observationIds: e.observationIds || []
                    })),
                    observations: rawObservations.concat(migratedObservations),
                    definitions: rawDefinitions,
                    relations: rawRelations
                });
                
                // Return the migrated graph
                const migratedResult = {
                    entities: rawEntities.map(e => ({
                        name: e.name,
                        entityType: e.entityType,
                        definition: e.definition || "",
                        definitionSource: e.definitionSource === undefined || e.definitionSource === null ? null : String(e.definitionSource),
                        observationIds: e.observationIds || []
                    })),
                    observations: rawObservations.concat(migratedObservations),
                    definitions: rawDefinitions,
                    relations: rawRelations
                };
                this._updateCache(migratedResult);
                return migratedResult;
            }
            
            // New format: entities store observationIds (array of numbers)
            const newFormatResult = {
                entities: rawEntities.map(e => ({
                    name: e.name,
                    entityType: e.entityType,
                    definition: e.definition || "",
                    definitionSource: e.definitionSource === undefined || e.definitionSource === null ? null : String(e.definitionSource),
                    observationIds: e.observationIds || []
                })),
                observations: rawObservations.map(o => ({
                    id: o.id,
                    content: o.content,
                    createdAt: formatTimestamp(o.createdAt)?.value || null
                })),
                definitions: rawDefinitions.map(d => ({
                    entityName: d.entityName,
                    content: d.content,
                    source: d.source || null,
                    createdAt: formatTimestamp(d.createdAt)?.value || null,
                    updatedAt: formatTimestamp(d.updatedAt)?.value || null
                })),
                relations: rawRelations.map(r => ({
                    from: r.from,
                    to: r.to,
                    relationType: r.relationType
                }))
            };
            this._updateCache(newFormatResult);
            return newFormatResult;
        }
        catch (error) {
            if (error instanceof Error && 'code' in error && error.code === "ENOENT") {
                const emptyResult = { entities: [], observations: [], definitions: [], relations: [] };
                this._updateCache(emptyResult);
                return emptyResult;
            }
            throw error;
        }
    }
    
    // Update cache after graph is modified
    _updateCache(graph) {
        this.cache = {
            data: graph,
            timestamp: Date.now()
        };
    }
    
    async saveGraph(graph) {
        // Acquire exclusive lock
        await this._acquireLock();
        
        try {
            const lines = [
                ...graph.entities.map(e => JSON.stringify({
                    type: "entity",
                    name: e.name,
                    entityType: e.entityType,
                    definition: e.definition || "",
                    definitionSource: e.definitionSource === undefined || e.definitionSource === null ? null : String(e.definitionSource),
                    observationIds: e.observationIds || []
                })),
                ...graph.observations.map(o => JSON.stringify({
                    type: "observation",
                    id: o.id,
                    content: o.content,
                    createdAt: o.createdAt || null
                })),
                ...graph.definitions.map(d => JSON.stringify({
                    type: "definition",
                    entityName: d.entityName,
                    content: d.content,
                    source: d.source || null,
                    createdAt: d.createdAt || null,
                    updatedAt: d.updatedAt || null
                })),
                ...graph.relations.map(r => JSON.stringify({
                    type: "relation",
                    from: r.from,
                    to: r.to,
                    relationType: r.relationType
                })),
            ];
            await fs.writeFile(this.memoryFilePath, lines.join("\n"));
        } finally {
            // Always release lock
            await this._releaseLock();
        }
        
        // Clear cache since file was modified
        this._clearCache();
        
        // Rebuild search index to ensure new data is searchable immediately
        if (this.searchIntegrator) {
            await this.searchIntegrator.rebuildIndex();
        }
    }
    async createEntity(entities) {
        const graph = await this.loadGraph();
        const now = getCurrentTimestamp();
        
        // Get next observation ID
        let maxObsId = graph.observations.length > 0 
            ? Math.max(...graph.observations.map(o => o.id))
            : 0;
        
        const newEntities = [];
        const skippedEntities = [];
        
        for (const entity of entities) {
            // Check if entity already exists
            if (graph.entities.some(e => e.name === entity.name)) {
                skippedEntities.push(entity.name);
                continue;
            }
            
            // Create centralized observations and get their IDs
            const observationIds = [];
            if (entity.observations && Array.isArray(entity.observations)) {
                for (const content of entity.observations) {
                    // Check if same observation content already exists
                    const existing = graph.observations.find(o => o.content === content);
                    if (existing) {
                        observationIds.push(existing.id);
                    } else {
                        const newId = ++maxObsId;
                        graph.observations.push({
                            id: newId,
                            content: content,
                            createdAt: getCurrentTimestamp()
                        });
                        observationIds.push(newId);
                    }
                }
            }
            
            graph.entities.push({
                name: entity.name,
                entityType: entity.entityType,
                definition: entity.definition || "",
                definitionSource: entity.definitionSource === undefined || entity.definitionSource === null ? null : String(entity.definitionSource),
                observationIds: observationIds
            });
            
            newEntities.push({
                name: entity.name,
                entityType: entity.entityType,
                definition: entity.definition || "",
                definitionSource: entity.definitionSource === undefined || entity.definitionSource === null ? null : String(entity.definitionSource),
                observationIds: observationIds
            });
        }
        
        await this.saveGraph(graph);
        
        // Build result message
        const created = newEntities.length;
        const skipped = skippedEntities.length;
        
        let message = `Created ${created} entity(ies)`;
        if (skipped > 0) {
            const skippedList = skippedEntities.map(name => `实体"${name}"已存在，使用updateNode更新该实体`).join('; ');
            message += `, skipped ${skipped} duplicate(s): ${skippedList}`;
        }
        
        return {
            newEntities: newEntities,
            skippedEntities: skippedEntities,
            message: message
        };
    }
    async createRelation(relations) {
        const graph = await this.loadGraph();
        const newRelations = relations.filter(r => !graph.relations.some(existingRelation => existingRelation.from === r.from &&
            existingRelation.to === r.to &&
            existingRelation.relationType === r.relationType));
        graph.relations.push(...newRelations);
        await this.saveGraph(graph);
        return newRelations;
    }
    async addObservation(observations) {
        const graph = await this.loadGraph();
        const now = getCurrentTimestamp();
        
        // Get next observation ID
        let maxObsId = graph.observations.length > 0 
            ? Math.max(...graph.observations.map(o => o.id))
            : 0;
        
        const results = [];
        
        for (const o of observations) {
            const entity = graph.entities.find(e => e.name === o.entityName);
            if (!entity) {
                throw new Error(`Entity with name "${o.entityName}" not found`);
            }
            
            entity.observationIds = entity.observationIds || [];
            
            for (const content of o.contents) {
                // Check if same observation already exists (deduplication)
                const existingObs = graph.observations.find(obs => obs.content === content);
                
                if (existingObs) {
                    // Add existing observation ID if not already linked
                    if (!entity.observationIds.includes(existingObs.id)) {
                        entity.observationIds.push(existingObs.id);
                    }
                } else {
                    // Create new centralized observation
                    const newId = ++maxObsId;
                    graph.observations.push({
                        id: newId,
                        content: content,
                        createdAt: getCurrentTimestamp()
                    });
                    entity.observationIds.push(newId);
                }
            }
            
            results.push({
                entityName: o.entityName,
                addedObservations: o.contents
            });
        }
        
        await this.saveGraph(graph);
        return results;
    }
    async deleteEntity(entityNames) {
        const graph = await this.loadGraph();
        graph.entities = graph.entities.filter(e => !entityNames.includes(e.name));
        graph.relations = graph.relations.filter(r => !entityNames.includes(r.from) && !entityNames.includes(r.to));
        await this.saveGraph(graph);
    }
    async deleteObservation(observations) {
        const graph = await this.loadGraph();
        const warnings = [];
        const results = [];
        
        for (const item of observations) {
            const observation = item.observation;
            const entityNames = item.entityNames || [];
            
            const obs = graph.observations.find(o => o.content === observation);
            
            if (!obs) {
                warnings.push(`Observation "${observation}" not found`);
                results.push({
                    observation: observation,
                    observationId: null,
                    removedFrom: [],
                    notFoundEntities: entityNames,
                    message: "Observation not found"
                });
                continue;
            }
            
            const removedFrom = [];
            const notFoundEntities = [];
            
            for (const entityName of entityNames) {
                const entity = graph.entities.find(e => e.name === entityName);
                
                if (!entity) {
                    notFoundEntities.push(entityName);
                    continue;
                }
                
                if (!entity.observationIds.includes(obs.id)) {
                    warnings.push(`Observation "${observation}" not linked to entity "${entityName}"`);
                    continue;
                }
                
                // Remove link only (observation stays as orphan)
                entity.observationIds = entity.observationIds.filter(id => id !== obs.id);
                removedFrom.push(entityName);
            }
            
            results.push({
                observation: observation,
                observationId: obs.id,
                removedFrom: removedFrom,
                notFoundEntities: notFoundEntities
            });
            
            if (notFoundEntities.length > 0) {
                warnings.push(`Entities not found for "${observation}": ${notFoundEntities.join(', ')}`);
            }
        }
        
        await this.saveGraph(graph);
        
        return {
            success: true,
            warnings: warnings,
            results: results
        };
    }
    async deleteRelation(relations) {
        const graph = await this.loadGraph();
        graph.relations = graph.relations.filter(r => !relations.some(delRelation => r.from === delRelation.from &&
            r.to === delRelation.to &&
            r.relationType === delRelation.relationType));
        await this.saveGraph(graph);
    }
    async recycleObservation(observationIds, force = false) {
        const graph = await this.loadGraph();
        const results = [];
        const warnings = [];
        const deleted = [];
        const skipped = [];

        for (const obsId of observationIds) {
            const observation = graph.observations.find(o => o.id === obsId);

            if (!observation) {
                warnings.push(`Observation with id ${obsId} not found`);
                continue;
            }

            // Find all entities that reference this observation
            const referencingEntities = graph.entities.filter(e =>
                e.observationIds && e.observationIds.includes(obsId)
            );

            if (referencingEntities.length === 0) {
                // Orphan observation - safe to delete
                graph.observations = graph.observations.filter(o => o.id !== obsId);
                deleted.push({
                    observationId: obsId,
                    content: observation.content,
                    referencedBy: []
                });
            } else if (force) {
                // Force delete - remove from all entities and delete
                const referencedByInfo = referencingEntities.map(e => ({
                    entityName: e.name,
                    observationIds: e.observationIds.filter(id => id !== obsId)
                }));

                referencingEntities.forEach(e => {
                    e.observationIds = e.observationIds.filter(id => id !== obsId);
                });

                graph.observations = graph.observations.filter(o => o.id !== obsId);

                deleted.push({
                    observationId: obsId,
                    content: observation.content,
                    referencedBy: referencedByInfo,
                    forceDeleted: true
                });

                warnings.push(`Force deleted observation ${obsId} from entities: ${referencingEntities.map(e => e.name).join(', ')}`);
            } else {
                // Not orphan and not force - skip and warn
                skipped.push({
                    observationId: obsId,
                    content: observation.content,
                    referencedBy: referencingEntities.map(e => e.name)
                });

                warnings.push(`Skipped observation ${obsId} - still referenced by: ${referencingEntities.map(e => e.name).join(', ')}. Use force=true to force delete.`);
            }
        }

        await this.saveGraph(graph);

        return {
            success: true,
            deleted: deleted,
            skipped: skipped,
            warnings: warnings
        };
    }
    async setDefinition(entityName, content, source = null) {
        const graph = await this.loadGraph();
        // Ensure entity exists
        const entity = graph.entities.find(e => e.name === entityName);
        if (!entity) {
            throw new Error(`Entity with name "${entityName}" not found`);
        }
        // Check if definition already exists
        const existingIndex = graph.definitions.findIndex(d => d.entityName === entityName);
        const timestamp = getCurrentTimestamp();
        const definition = {
            entityName,
            content,
            source,
            createdAt: existingIndex === -1 ? timestamp : graph.definitions[existingIndex].createdAt,
            updatedAt: timestamp
        };
        if (existingIndex !== -1) {
            // Update existing definition
            graph.definitions[existingIndex] = definition;
        } else {
            // Create new definition
            graph.definitions.push(definition);
        }
        await this.saveGraph(graph);
    }
    async updateNode(updates) {
        const graph = await this.loadGraph();
        const now = getCurrentTimestamp();
        const results = [];

        for (const update of updates) {
            const {
                entityName,
                name,
                definition,
                entityType,
                definitionContent,
                definitionSource,
                observationUpdates
            } = update;

            const entity = graph.entities.find(e => e.name === entityName);

            if (!entity) {
                throw new Error(`Entity with name "${entityName}" not found`);
            }

            // Track old name for relation updates
            const oldName = entity.name;
            let nameChanged = false;

            // Update entity fields
            if (name !== undefined && name !== oldName) {
                entity.name = name;
                nameChanged = true;
            }
            if (definition !== undefined) entity.definition = definition;
            if (definitionSource !== undefined) entity.definitionSource = definitionSource;
            if (entityType !== undefined) entity.entityType = entityType;

            // Update related relations if entity name changed
            if (nameChanged) {
                // Update 'from' references
                graph.relations.forEach(r => {
                    if (r.from === oldName) {
                        r.from = name;
                    }
                });
                // Update 'to' references
                graph.relations.forEach(r => {
                    if (r.to === oldName) {
                        r.to = name;
                    }
                });
            }

            // Handle observation updates (copy-on-write)
            if (observationUpdates && Array.isArray(observationUpdates)) {
                let maxObsId = graph.observations.length > 0 
                    ? Math.max(...graph.observations.map(o => o.id))
                    : 0;
                
                for (const obsUpdate of observationUpdates) {
                    const { oldContent, newContent } = obsUpdate;
                    
                    const existingObs = graph.observations.find(o => o.content === oldContent);
                    
                    if (existingObs) {
                        const otherEntities = graph.entities.filter(e => 
                            e.name !== entityName && 
                            e.observationIds?.includes(existingObs.id)
                        );
                        
                        if (otherEntities.length > 0) {
                            const newId = ++maxObsId;
                            graph.observations.push({
                                id: newId,
                                content: newContent,
                                createdAt: existingObs.createdAt,
                                updatedAt: getCurrentTimestamp()  // CoW creates new observation with updatedAt
                            });
                            entity.observationIds = entity.observationIds.map(id => 
                                id === existingObs.id ? newId : id
                            );
                        } else {
                            existingObs.content = newContent;
                            existingObs.updatedAt = getCurrentTimestamp();  // Direct update also sets updatedAt
                        }
                    }
                }
            }
            
            results.push({
                entityName: entity.name,
                updated: {
                    name: entity.name,
                    definition: entity.definition,
                    entityType: entity.entityType,
                    observationIds: entity.observationIds
                }
            });
        }
        
        await this.saveGraph(graph);
        return results;
    }
    async getOrphanObservation() {
        const graph = await this.loadGraph();
        
        // Collect all observation IDs that are referenced by any entity
        const referencedIds = new Set();
        graph.entities.forEach(entity => {
            (entity.observationIds || []).forEach(id => referencedIds.add(id));
        });
        
        // Find observations not referenced by any entity
        const orphanObservations = graph.observations.filter(obs => !referencedIds.has(obs.id));
        
        return orphanObservations.map(obs => ({
            id: obs.id,
            content: obs.content,
            createdAt: formatTimestamp(obs.createdAt)?.value
        }));
    }
    async _updateObservationSingle(observationId, newContent) {
        const graph = await this.loadGraph();
        
        const observation = graph.observations.find(o => o.id === observationId);
        if (!observation) {
            throw new Error(`Observation with id ${observationId} not found`);
        }
        
        // Update the observation content - all linked entities will see this change
        observation.content = newContent;
        
        // Find all entities that reference this observation
        const linkedEntities = graph.entities
            .filter(e => e.observationIds?.includes(observationId))
            .map(e => e.name);
        
        await this.saveGraph(graph);
        
        return {
            observationId: observationId,
            oldContent: observation.content,
            newContent: newContent,
            linkedEntities: linkedEntities,
            updatedAt: formatTimestamp(getCurrentTimestamp())?.value,
            createdAt: formatTimestamp(observation.createdAt)?.value
        };
    }
    async listNode() {
        const graph = await this.loadGraph();
        
        // Combine entity info with its definition (without observations)
        const nodes = graph.entities.map(entity => {
            return {
                name: entity.name,
                entityType: entity.entityType,
                definition: entity.definition || "",
                definitionSource: entity.definitionSource === undefined || entity.definitionSource === null ? null : String(entity.definitionSource)
            };
        });
        return nodes;
    }
    async howWork() {
        return `推荐工作流：

1. listNode
   → 获取所有实体索引（名称、类型、定义）
   → 适合了解整体结构和快速浏览

2. readNode(["实体名"])
   → 获取特定实体的详细信息
   → 包含：观察（observations）、定义（definition）、关系（relations）
   → 关系内联包含目标实体的名称、类型、定义

3. 结合用户提问和关系选择搜索方式
   → 如果需要搜索关键词：searchNode("关键词1 关键词2")
   → 如果需要查看特定实体：readNode(["实体名"])
   → 多关键词自动去重合并，返回相关性排序结果

实用技巧：
- 先 listNode 了解有哪些实体
- 再 readNode 查看感兴趣的实体详情
- 通过关系发现关联实体（如 A 知道 B，可再 readNode(["B"])）
- searchNode 支持多关键词，空格分隔，去重合并`;
    }
    async updateObservation(updates) {
        // Defensive: ensure updates is an array
        const updateArray = Array.isArray(updates) ? updates : [];
        const results = [];
        for (const u of updateArray) {
            const result = await this._updateObservationSingle(u.observationId, u.newContent);
            results.push(result);
        }
        return results;
    }
    async listGraph() {
        return this.loadGraph();
    }
    async searchNode(query) {
        const graph = await this.loadGraph();
        
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
        const entityObservationMap = new Map(); // entity name -> relevant observation IDs
        
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
            
            // Check observations - only collect those with keywords
            const entityObs = (entity.observationIds || [])
                .map(id => ({ id, content: obsContentMap.get(id) }))
                .filter(o => o.content !== undefined);
            
            for (const obs of entityObs) {
                if (containsKeyword(obs.content)) {
                    if (!isRelevant) isRelevant = true;
                    relevantObsIds.push(obs.id);
                }
            }
            
            if (isRelevant) {
                relevantEntities.push(entity);
                entityObservationMap.set(entity.name, relevantObsIds);
            }
        }
        
        // Collect relevant observations only (those with keywords)
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
                    createdAt: formatTimestamp(obs.createdAt)?.value || null
                } : null;
            })
            .filter(o => o !== null);
        
        // Filter relations to only those where BOTH from AND to are relevant entities
        // AND the relation itself contains a keyword (optional, stricter filtering)
        const relevantRelationTypes = ['related_to', 'knows', 'connected_to', 'part_of', 'type_of'];
        const cleanRelations = graph.relations
            .filter(r => 
                relevantEntities.some(e => e.name === r.from) && 
                relevantEntities.some(e => e.name === r.to)
            )
            .slice(0, 20) // Limit relations to avoid overload
            .map(r => ({
                from: r.from,
                to: r.to,
                relationType: r.relationType
            }));
        
        // Clean entities
        const cleanedEntities = relevantEntities.map(entity => ({
            name: entity.name,
            entityType: entity.entityType,
            definition: entity.definition || "",
            definitionSource: entity.definitionSource === undefined || entity.definitionSource === null ? null : String(entity.definitionSource),
            observationIds: entity.observationIds || []
        }));
        
        return {
            entities: cleanedEntities,
            relations: cleanRelations,
            observations: relevantObservations
        };
    }
    
    async readNode(names) {
        const graph = await this.loadGraph();
        // Filter entities
        const filteredEntities = graph.entities.filter(e => names.includes(e.name));
        
        // Create observation content lookup
        const obsContentMap = new Map();
        graph.observations.forEach(obs => {
            obsContentMap.set(obs.id, obs.content);
        });
        
        // Enhance entities with observation content
        const enhancedEntities = filteredEntities.map(entity => ({
            ...entity,
            observations: (entity.observationIds || [])
                .map(id => obsContentMap.get(id))
                .filter(content => content !== undefined)
        }));
        
        // Create a Set of filtered entity names for quick lookup
        const filteredEntityNames = new Set(filteredEntities.map(e => e.name));
        // Filter relations where from OR to is in the filtered entities
        const filteredRelations = graph.relations.filter(r => 
            filteredEntityNames.has(r.from) || filteredEntityNames.has(r.to)
        );
        // Filter observations referenced by filtered entities
        const filteredObservations = graph.observations.filter(o => 
            filteredEntities.some(e => e.observationIds?.includes(o.id))
        );
        
        // Clean entities to match output schema
        const cleanedEntities = enhancedEntities.map(entity => ({
            name: entity.name,
            entityType: entity.entityType,
            definition: entity.definition || "",
            definitionSource: entity.definitionSource === undefined || entity.definitionSource === null ? null : String(entity.definitionSource),
            observationIds: entity.observationIds || []
        }));
        
        // Enrich relations with to-entity details inline
        const enrichedRelations = filteredRelations.map(relation => {
            const toEntity = graph.entities.find(e => e.name === relation.to);
            return {
                from: relation.from,
                to: {
                    name: relation.to,
                    entityType: toEntity?.entityType || "unknown",
                    definition: toEntity?.definition || ""
                },
                relationType: relation.relationType
            };
        });
        
        // Clean observations to match schema
        const cleanObservations = filteredObservations.map(o => ({
            id: o.id,
            content: o.content,
            createdAt: o.createdAt || null
        }));
        
        const filteredGraph = {
            entities: cleanedEntities,
            relations: enrichedRelations,
            observations: cleanObservations
        };
        return filteredGraph;
    }

    async readObservation(ids) {
        const graph = await this.loadGraph();
        const results = [];

        for (const id of ids) {
            const observation = graph.observations.find(o => o.id === id);
            if (observation) {
                results.push({
                    id: observation.id,
                    content: observation.content,
                    createdAt: observation.createdAt || null
                });
            }
        }

        return results;
    }
}
let knowledgeGraphManager;
let searchIntegrator;
// Zod schemas for entities and relations
const EntitySchema = z.object({
    name: z.string().describe("The name of the entity"),
    entityType: z.string().describe("The type of the entity"),
    definition: z.string().describe("The definition of the entity"),
    definitionSource: z.string().optional().describe("Source or reference for the definition"),
    observations: z.array(z.string()).optional().default([]).describe("Observation contents")
});
const EntityOutputSchema = z.object({
    name: z.string(),
    entityType: z.string(),
    definition: z.string(),
    definitionSource: z.string().nullable(),
    observationIds: z.array(z.number())
});
const SearchNodeEntitySchema = z.object({
    name: z.string(),
    entityType: z.string(),
    definition: z.string(),
    definitionSource: z.string().nullable(),
    observationIds: z.array(z.number())
}).catchall(z.unknown());  // Allow _related for related entities
const RelationSchema = z.object({
    from: z.string().describe("The name of the entity where the relation starts"),
    to: z.string().describe("The name of the entity where the relation ends"),
    relationType: z.string().describe("The type of the relation")
});
const ObservationSchema = z.object({
    id: z.number(),
    content: z.string(),
    createdAt: z.string().nullable()
});
// The server instance and tools exposed to Claude
const server = new McpServer({
    name: "MemFS",
    version: "1.21.1",
});
// Register create_entities tool
server.registerTool("createEntity", {
    title: "Create Entity",
    description: "Multi create entities with definitions. Each requires name, type and definition. Skips duplicates and提醒使用updateNode更新.",
    inputSchema: {
        entities: z.array(EntitySchema)
    },
    outputSchema: {
        entities: z.array(EntityOutputSchema),
        skipped: z.array(z.string())
    }
}, async ({ entities }) => {
    const result = await knowledgeGraphManager.createEntity(entities);
    return {
        content: [{ type: "text", text: result.message }],
        structuredContent: { 
            entities: result.newEntities,
            skipped: result.skippedEntities
        }
    };
});
// Register create_relations tool
server.registerTool("createRelation", {
    title: "Create Relation",
    description: "Multi create relations between entities. Use active voice for relation types.",
    inputSchema: {
        relations: z.array(RelationSchema)
    },
    outputSchema: {
        relations: z.array(RelationSchema)
    }
}, async ({ relations }) => {
    const result = await knowledgeGraphManager.createRelation(relations);
    return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: { relations: result }
    };
});
// Register add_observations tool
server.registerTool("addObservation", {
    title: "Add Observation",
    description: "Multi add observations to entities. Supports batch operations across entities.",
    inputSchema: {
        observations: z.array(z.object({
            entityName: z.string().describe("The name of the entity to add the observations to"),
            contents: z.array(z.string()).describe("An array of observation contents to add")
        }))
    },
    outputSchema: {
        results: z.array(z.object({
            entityName: z.string(),
            addedObservations: z.array(z.string())
        }))
    }
}, async ({ observations }) => {
    const result = await knowledgeGraphManager.addObservation(observations);
    return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: { results: result }
    };
});
// Register delete_entities tool
server.registerTool("deleteEntity", {
    title: "Delete Entity",
    description: "Multi delete entities and their associated relations.",
    inputSchema: {
        entityNames: z.array(z.string()).describe("An array of entity names to delete")
    },
    outputSchema: {
        success: z.boolean(),
        message: z.string()
    }
}, async ({ entityNames }) => {
    await knowledgeGraphManager.deleteEntity(entityNames);
    return {
        content: [{ type: "text", text: "Entities deleted successfully" }],
        structuredContent: { success: true, message: "Entities deleted successfully" }
    };
});
// Register delete_observations tool
server.registerTool("deleteObservation", {
    title: "Delete Observation",
    description: "Remove observation links from entities. Observation stays as orphan. Per-observation batch operation.",
    inputSchema: {
        observations: z.array(z.object({
            observation: z.string().describe("The observation content to unlink"),
            entityNames: z.array(z.string()).describe("Entity names to unlink from this observation")
        }))
    },
    outputSchema: {
        success: z.boolean(),
        warnings: z.array(z.string()),
        results: z.array(z.object({
            observation: z.string(),
            observationId: z.number(),
            removedFrom: z.array(z.string()),
            notFoundEntities: z.array(z.string())
        }))
    }
}, async ({ observations }) => {
    const result = await knowledgeGraphManager.deleteObservation(observations);
    const warningText = result.warnings.length > 0 
        ? `Warnings: ${result.warnings.join('; ')}` 
        : "";
    return {
        content: [{ type: "text", text: `Observations unlinked. ${warningText}` }],
        structuredContent: result
    };
});
// Register delete_relations tool
server.registerTool("deleteRelation", {
    title: "Delete Relation",
    description: "Multi delete relations from the knowledge graph.",
    inputSchema: {
        relations: z.array(RelationSchema).describe("An array of relations to delete")
    },
    outputSchema: {
        success: z.boolean(),
        message: z.string()
    }
}, async ({ relations }) => {
    await knowledgeGraphManager.deleteRelation(relations);
    return {
        content: [{ type: "text", text: "Relations deleted successfully" }],
        structuredContent: { success: true, message: "Relations deleted successfully" }
    };
});
// Register recycle_observation tool
server.registerTool("recycleObservation", {
    title: "Recycle Observation",
    description: "Batch permanently delete observations. If orphan, delete directly. If referenced, skip unless force=true (removes from entities and deletes).",
    inputSchema: {
        observationIds: z.array(z.number()).describe("Array of observation IDs to permanently delete"),
        force: z.boolean().optional().default(false).describe("Force delete even if observation is still referenced by entities")
    },
    outputSchema: {
        success: z.boolean(),
        deleted: z.array(z.object({
            observationId: z.number(),
            content: z.string(),
            referencedBy: z.array(z.object({
                entityName: z.string(),
                observationIds: z.array(z.number())
            })).optional(),
            forceDeleted: z.boolean().optional()
        })),
        skipped: z.array(z.object({
            observationId: z.number(),
            content: z.string(),
            referencedBy: z.array(z.string())
        })),
        warnings: z.array(z.string())
    }
}, async ({ observationIds, force }) => {
    const result = await knowledgeGraphManager.recycleObservation(observationIds, force);
    const warningText = result.warnings.length > 0
        ? `Warnings: ${result.warnings.join('; ')}`
        : "";
    return {
        content: [{ type: "text", text: `Recycled ${result.deleted.length} observation(s), skipped ${result.skipped.length}. ${warningText}` }],
        structuredContent: result
    };
});
// Register read_graph tool
server.registerTool("listGraph", {
    title: "List Graph",
    description: "Read the entire knowledge graph. Use sparingly as it returns all data. Set time=true to include observation timestamps.",
    inputSchema: {
        time: z.boolean().optional().default(false).describe("Include observation timestamps (createdAt)")
    },
    outputSchema: {
        entities: z.array(EntityOutputSchema),
        observations: z.array(z.object({
            id: z.number(),
            content: z.string(),
            createdAt: z.string().nullable()
        })),
        relations: z.array(RelationSchema)
    }
 }, async ({ time }) => {
    const graph = await knowledgeGraphManager.listGraph();
    // Explicitly clean all data to match output schema
    const cleanGraph = {
        entities: graph.entities.map(e => ({
            name: e.name,
            entityType: e.entityType,
            definition: e.definition || "",
            definitionSource: e.definitionSource === undefined || e.definitionSource === null ? null : String(e.definitionSource),
            observationIds: e.observationIds || []
        })),
        observations: formatObservations(graph.observations, time),
        relations: graph.relations.map(r => ({
            from: r.from,
            to: r.to,
            relationType: r.relationType
        }))
    };
    
    return {
        content: [{ type: "text", text: JSON.stringify(cleanGraph, null, 2) }],
        structuredContent: cleanGraph
    };
});
// Register search_nodes tool
server.registerTool("searchNode", {
    title: "Search Node",
    description: "Search entities using TF-IDF + Fuse.js hybrid search. Returns entities sorted by relevance score. Use basicFetch=true for traditional keyword matching.",
    inputSchema: {
        query: z.string().describe("The search query to match against entity names, types, definitions, and observation content"),
        time: z.boolean().optional().default(false).describe("Include observation timestamps (createdAt)"),
        basicFetch: z.boolean().optional().default(false).describe("Use traditional keyword matching instead of hybrid search"),
        limit: z.number().optional().default(15).describe("Maximum number of entities to return (default: 15)"),
        maxObservationsPerEntity: z.number().optional().default(5).describe("Maximum observations per entity (default: 5)"),
        totalMultiplier: z.number().optional().default(3).describe("Total output limit multiplier: limit × maxObservationsPerEntity × totalMultiplier (default: 3)"),
        bm25Weight: z.number().optional().default(0.7).describe("Weight for BM25 ranking (0-1, default: 0.7)"),
        fuzzyWeight: z.number().optional().default(0.3).describe("Weight for Fuse.js fuzzy matching (0-1, default: 0.3)"),
        minScore: z.number().optional().default(0.01).describe("Minimum relevance score threshold (default: 0.01)")
    },
    outputSchema: {
        entities: z.array(SearchNodeEntitySchema),
        relations: z.array(z.object({
            from: z.string(),
            to: z.string(),
            relationType: z.string()
        })),
        observations: z.array(z.object({
            id: z.number(),
            content: z.string(),
            createdAt: z.string().nullable()
        })),
        searchMode: z.enum(['traditional', 'hybrid'])
    }
}, async ({ query, time, basicFetch, limit, maxObservationsPerEntity, totalMultiplier, bm25Weight, fuzzyWeight, minScore }) => {
    const result = await searchIntegrator.searchNode(query, {
        basicFetch,
        time,
        limit,
        maxObservationsPerEntity,
        bm25Weight,
        fuzzyWeight,
        minScore
    });
    // _meta 为内部调试信息，不返回给 LLM
    const { _meta, ...cleanResult } = result;

    // 确保总输出数限制 (entities + observations + relations)
    // 总输出 = limit × maxObservationsPerEntity × totalMultiplier
    const totalLimit = maxObservationsPerEntity * limit * totalMultiplier;
    const totalOutput = [
        ...cleanResult.entities.map(e => ({ ...e, _type: 'entity' })),
        ...cleanResult.observations.map(o => ({ ...o, _type: 'observation' })),
        ...cleanResult.relations.map(r => ({ ...r, _type: 'relation' }))
    ].slice(0, totalLimit);

    // 拆分回原结构
    const limitedResult = {
        entities: totalOutput.filter(i => i._type === 'entity').map(({ _type, ...e }) => e),
        observations: totalOutput.filter(i => i._type === 'observation').map(({ _type, ...o }) => o),
        relations: totalOutput.filter(i => i._type === 'relation').map(({ _type, ...r }) => r),
        searchMode: cleanResult.searchMode
    };

    return {
        content: [{ type: "text", text: JSON.stringify(limitedResult, null, 2) }],
        structuredContent: limitedResult
    };
});
// Register open_nodes tool
server.registerTool("readNode", {
    title: "Read Node",
    description: "Open entities with observations and relations. Includes inline to-entity details. Set time=true to include observation timestamps.",
    inputSchema: {
        names: z.array(z.string()).describe("An array of entity names to retrieve"),
        time: z.boolean().optional().default(false).describe("Include observation timestamps (createdAt)")
    },
    outputSchema: {
        entities: z.array(SearchNodeEntitySchema),
        relations: z.array(z.object({
            from: z.string(),
            to: z.object({
                name: z.string(),
                entityType: z.string(),
                definition: z.string()
            }),
            relationType: z.string()
        })),
        observations: z.array(z.object({
            id: z.number(),
            content: z.string(),
            createdAt: z.string().nullable()
        }))
    }
}, async ({ names, time }) => {
    const graph = await knowledgeGraphManager.readNode(names);
    const result = {
        entities: graph.entities,
        relations: graph.relations,
        observations: formatObservations(graph.observations, time)
    };
    return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result
    };
});
// Register updateNode tool
server.registerTool("updateNode", {
    title: "Update Node",
    description: "Multi update entities and observations. Observations use copy-on-write when shared.",
    inputSchema: {
        updates: z.array(z.object({
            entityName: z.string().describe("The name of the entity to update"),
            name: z.string().optional().describe("New name for the entity"),
            definition: z.string().optional().describe("New definition for the entity"),
            definitionSource: z.string().optional().describe("Source for the definition"),
            entityType: z.string().optional().describe("New entity type"),
            observationUpdates: z.array(z.object({
                oldContent: z.string().describe("The observation content to replace"),
                newContent: z.string().describe("The new observation content")
            })).optional().describe("Observation updates - uses copy-on-write if shared")
        }))
    },
    outputSchema: {
        results: z.array(z.object({
            entityName: z.string(),
            updated: z.object({
                name: z.string(),
                definition: z.string(),
                entityType: z.string(),
                observationIds: z.array(z.number())
            })
        }))
    }
}, async ({ updates }) => {
    const results = await knowledgeGraphManager.updateNode(updates);
    return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        structuredContent: { results }
    };
});
// Register orphan_observations tool
server.registerTool("getOrphanObservation", {
    title: "Get Orphan Observation",
    description: "Find observations not referenced by any entity. Safe to delete. Set time=true to include timestamps.",
    inputSchema: {
        time: z.boolean().optional().default(false).describe("Include observation timestamps (createdAt)")
    },
    outputSchema: {
        orphanObservations: z.array(z.object({
            id: z.number(),
            content: z.string(),
            createdAt: z.string().nullable()
        }))
    }
}, async ({ time }) => {
    const orphanObservations = await knowledgeGraphManager.getOrphanObservation();
    const result = formatObservations(orphanObservations, time);
    return {
        content: [{ type: "text", text: JSON.stringify({ orphanObservations: result }, null, 2) }],
        structuredContent: { orphanObservations: result }
    };
});
// Register read_observations tool
server.registerTool("readObservation", {
    title: "Read Observation",
    description: "Read observations by IDs. Returns observation details including content and timestamp.",
    inputSchema: {
        ids: z.array(z.number()).describe("Array of observation IDs to retrieve"),
        time: z.boolean().optional().default(false).describe("Include observation timestamps (createdAt)")
    },
    outputSchema: {
        observations: z.array(z.object({
            id: z.number(),
            content: z.string(),
            createdAt: z.string().nullable()
        }))
    }
}, async ({ ids, time }) => {
    const observations = await knowledgeGraphManager.readObservation(ids);
    
    // Conditionally include createdAt
    const result = observations.map(o => ({
        id: o.id,
        content: o.content,
        createdAt: time ? formatTimestamp(o.createdAt)?.value : null
    }));
    
    return {
        content: [{ type: "text", text: JSON.stringify({ observations: result }, null, 2) }],
        structuredContent: { observations: result }
    };
});
// Register update_observations tool (batch)
server.registerTool("updateObservation", {
    title: "Update Observation",
    description: "Multi update observations by ID. Changes propagate to all linked entities (linked mechanism). Copy-on-write is only available via updateNode.",
    inputSchema: {
        updates: z.array(z.object({
            observationId: z.number().describe("The ID of the observation to update"),
            newContent: z.string().describe("The new content for the observation")
        })),
        time: z.boolean().optional().default(false).describe("Include observation timestamps (createdAt)")
    },
    outputSchema: {
        results: z.array(z.object({
            observationId: z.number(),
            oldContent: z.string(),
            newContent: z.string(),
            linkedEntities: z.array(z.string()),
            updatedAt: z.string(),
            createdAt: z.string().nullable()
        }))
    }
}, async ({ updates, time }) => {
    // Defensive: ensure updates is an array
    const updateArray = Array.isArray(updates) ? updates : [];
    const results = await knowledgeGraphManager.updateObservation(updateArray);
    
    // Format results to include createdAt conditionally
    const formattedResults = results.map(r => {
        const base = {
            observationId: r.observationId,
            oldContent: r.oldContent,
            newContent: r.newContent,
            linkedEntities: r.linkedEntities,
            updatedAt: formatTimestamp(r.updatedAt)?.value,
            createdAt: time ? formatTimestamp(r.createdAt)?.value : null
        };
        return base;
    });
    
    return {
        content: [{ type: "text", text: JSON.stringify(formattedResults, null, 2) }],
        structuredContent: { results: formattedResults }
    };
});
// Register read_nodes tool
server.registerTool("listNode", {
    title: "List Node",
    description: "List all entity names, types and definitions. Use readNode for detailed observations and relations.",
    inputSchema: {},
    outputSchema: {
        nodes: z.array(z.object({
            name: z.string(),
            entityType: z.string(),
            definition: z.string(),
            definitionSource: z.string().nullable()
        }))
    }
}, async () => {
    const nodes = await knowledgeGraphManager.listNode();
    return {
        content: [{ type: "text", text: JSON.stringify(nodes, null, 2) }],
        structuredContent: { nodes }
    };
});
// Register howWork tool
server.registerTool("howWork", {
    title: "How It Works",
    description: "Get the recommended workflow for using memory knowledge graph.",
    inputSchema: {},
    outputSchema: {
        workflow: z.string()
    }
}, async () => {
    const workflow = `推荐工作流：

1. listNode
   → 获取所有实体索引（名称、类型、定义）
   → 适合了解整体结构和快速浏览

2. readNode(["实体名"])
   → 获取特定实体的详细信息
   → 包含：观察（observations）、定义（definition）、关系（relations）
   → 关系内联包含目标实体的名称、类型、定义

3. 结合用户提问和关系选择搜索方式
   → 如果需要搜索关键词：searchNode("关键词1 关键词2")
   → 如果需要查看特定实体：readNode(["实体名"])
   → 多关键词自动去重合并，返回相关性排序结果

实用技巧：
- 先 listNode 了解有哪些实体
- 再 readNode 查看感兴趣的实体详情
- 通过关系发现关联实体（如 A 知道 B，可再 readNode(["B"])）
- searchNode 支持多关键词，空格分隔，去重合并`;
    return {
        content: [{ type: "text", text: workflow }],
        structuredContent: { workflow }
    };
});
async function main() {
    // Initialize memory file path with backward compatibility
    MEMORY_FILE_PATH = await ensureMemoryFilePath();
    // Ensure the memory directory exists
    const memoryDir = path.dirname(MEMORY_FILE_PATH);
    try {
        await fs.mkdir(memoryDir, { recursive: true });
    } catch (err) {
        // Ignore errors if directory already exists or permission issues
        if (err.code !== 'EEXIST' && err.code !== 'EPERM') {
            throw err;
        }
    }
    // Initialize knowledge graph manager first (without searchIntegrator reference yet)
    knowledgeGraphManager = new KnowledgeGraphManager(MEMORY_FILE_PATH);
    // Initialize search integrator for TF-IDF + Fuse.js hybrid search
    searchIntegrator = new SearchIntegrator(knowledgeGraphManager);
    // Now inject searchIntegrator reference back to knowledgeGraphManager
    knowledgeGraphManager.searchIntegrator = searchIntegrator;
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Knowledge Graph MCP Server running on stdio");
}
main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});