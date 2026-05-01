#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Fuse from 'fuse.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { homedir, hostname, userInfo } from 'os';
import { execSync, execFileSync } from 'child_process';

// Import search modules
import { SearchIntegrator } from './src/tfidf/searchIntegrator.js';

// Global constants
const VERSION = "2.4.17";

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
    // Check for custom file path via MEMORY_FILE_PATH environment variable (DEPRECATED)
    if (process.env.MEMORY_FILE_PATH) {
        console.error('[Deprecation Warning] MEMORY_FILE_PATH is deprecated and will be removed in v2.0.');
        console.error('[Deprecation Warning] Please migrate to MEMORY_DIR instead. Example:');
        console.error('[Deprecation Warning]   1. Rename your memory file to memory.jsonl');
        console.error('[Deprecation Warning]   2. Move it to a dedicated folder');
        console.error('[Deprecation Warning]   3. Use: MEMORY_DIR=/path/to/folder node index.js');
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

// Git Sync 功能 - 自动提交记忆文件到 git
// Git Sync feature - auto-commit memory file to git
const gitSync = {
    enabled: false,
    initialized: false,
    memoryDir: null,
    
    // Check if git sync is enabled
    isEnabled() {
        if (this.enabled) return true;
        const gitsync = process.env.GITAUTOCOMMIT;
        this.enabled = (gitsync === 'true' || gitsync === '1' || gitsync?.toLowerCase() === 'yes');
        return this.enabled;
    },
    
    // Log to console buffer (for getConsole tool)
    // Note: console.error is globally overridden to also push to consoleBuffer,
    // so we don't need to push here - just call console.error.
    log(level, message) {
        console.error(`[Git] ${message}`);
    },
    
    // Execute git command
    execGit(args, cwd) {
        try {
            // Use execFileSync instead of execSync to properly handle arguments with spaces
            // execSync with string concatenation fails on Windows when args contain spaces
            const result = execFileSync('git', args, { 
                cwd, 
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe']
            });
            return { success: true, output: result || '' };
        } catch (error) {
            // execFileSync throws on non-zero exit, capture full error info
            const exitCode = error.status !== undefined ? error.status : 'unknown';
            const stderr = error.stderr ? error.stderr.toString() : '';
            const message = error.message || 'Unknown error';
            return { 
                success: false, 
                error: `[exit:${exitCode}] ${message}${stderr ? ' stderr: ' + stderr : ''}`,
                exitCode,
                stderr
            };
        }
    },
    
    // Check if git is installed
    async isGitInstalled() {
        const result = await this.execGit(['--version']);
        return result.success;
    },
    
    // Check if directory is a git repo (not just inside one)
    async isGitRepo(dir) {
        // Check if .git exists specifically in this directory
        const gitDir = path.join(dir, '.git');
        try {
            const stat = await fs.stat(gitDir);
            return stat.isDirectory();
        } catch {
            // .git doesn't exist in this directory
            return false;
        }
    },
    
    // Initialize git repo in memory directory
    async initRepo(dir) {
        if (this.initialized) return true;
        
        this.memoryDir = dir;
        
        // Check if git is installed
        if (!await this.isGitInstalled()) {
            this.log('warn', 'Git not installed, git sync disabled');
            return false;
        }
        
        // Check if already a git repo
        if (await this.isGitRepo(dir)) {
            this.log('info', 'Git repo already exists at ' + dir);
        } else {
            // Initialize new git repo
            const result = await this.execGit(['init'], dir);
            if (!result.success) {
                this.log('error', 'Failed to initialize git repo: ' + result.error);
                return false;
            }
            this.log('info', 'Initialized new git repo at ' + dir);
        }
        
        // Configure user (required for commits) - always set even if repo already exists
        // Format: author:"memfs-(version)", email:"username-memfs@hostname"
        const username = userInfo().username;
        const hostnameStr = hostname();
        await this.execGit(['config', 'user.email', `${username}-memfs@${hostnameStr}`], dir);
        await this.execGit(['config', 'user.name', `memfs-${VERSION}`], dir);
        
        this.initialized = true;
        return true;
    },
    
    // Auto-commit memory file changes
    async autoCommit(memoryFilePath, operationContext = null) {
        try {
            console.error('[Git] autoCommit called, enabled:', this.enabled, 'initialized:', this.initialized);
            if (!this.isEnabled()) return;
            if (!this.initialized) return;
            
            const dir = this.memoryDir;
            const fileName = path.basename(memoryFilePath);
            
            // Check if file exists
            try {
                await fs.access(memoryFilePath);
            } catch {
                console.error('[Git] File does not exist yet');
                return; // File doesn't exist yet
            }
            
            // git add
            const addResult = this.execGit(['add', fileName], dir);
            console.error('[Git] git add result:', addResult.success, addResult.output || addResult.error);
            if (!addResult.success) {
                this.log('warn', 'Failed to git add: ' + addResult.error);
                return;
            }
            
            // Check if there are changes to commit
            const statusResult = this.execGit(['status', '--porcelain'], dir);
            console.error('[Git] git status result:', statusResult.success, 'output:', statusResult.output);
            if (!statusResult.success || !statusResult.output.trim()) {
                console.error('[Git] No changes to commit');
                return; // No changes to commit
            }
            
            // git commit with timestamp and operation context
            // Format: auto-commit:[operationContext] at [utc:YYYY-MM-DDTHH:mm:ss.SSSZ] [tz:Asia/Shanghai]
            const timestamp = new Date().toISOString(); // ISO 8601 UTC format
            const tz = getSystemTimezone();
            const opInfo = operationContext ? `${operationContext}` : '';
            const commitMsg = `auto-commit:[${opInfo}] at [utc:${timestamp}] [tz:${tz}]`;
            
            const commitResult = this.execGit(['commit', '-m', commitMsg], dir);
            if (commitResult.success) {
                this.log('info', `Auto-committed: ${commitMsg}`);
            } else {
                this.log('warn', 'Failed to commit: ' + commitResult.error);
            }
        } catch (e) {
            console.error('[Git] autoCommit exception:', e.message, e.stack);
        }
    }
};

// Initialize memory file path (will be set during startup)
let MEMORY_FILE_PATH;
// Helper function to format observations - conditionally include createdAt
// Handles multiple timestamp formats:
// - UTC ISO: "2026-02-08T08:18:30.317Z" -> returns as-is
// - Local+offset: "2026-02-09 07:14:05+0800" -> returns as-is
// - New format: {utc, timezone} -> converts to local time with IANA timezone
function formatObservations(observations, includeTime = false) {
    return observations.map(o => {
        let createdAt = null, updatedAt = null;
        if (includeTime) {
            if (o.createdAt && typeof o.createdAt === 'object' && o.createdAt.utc) {
                createdAt = formatWithTimezone(o.createdAt.utc, o.createdAt.timezone);
            } else if (o.createdAt && typeof o.createdAt === 'string') {
                createdAt = o.createdAt;
            }
            if (o.updatedAt && typeof o.updatedAt === 'object' && o.updatedAt.utc) {
                updatedAt = formatWithTimezone(o.updatedAt.utc, o.updatedAt.timezone);
            } else if (o.updatedAt && typeof o.updatedAt === 'string') {
                updatedAt = o.updatedAt;
            }
        }
        return { id: o.id, content: o.content, createdAt, updatedAt };
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

// Parse formatted timestamp back to storage format
// "2026-02-09 22:02:06 Asia/Shanghai" -> {utc: "2026-02-09T14:02:06Z", timezone: "Asia/Shanghai"}
function parseTimestampToStorage(formattedValue) {
    if (!formattedValue) return null;
    
    // Already an object (new format)
    if (typeof formattedValue === 'object' && formattedValue.utc) {
        return formattedValue;
    }
    
    // New format: "2026-02-09 22:02:06 Asia/Shanghai"
    const newFormatMatch = formattedValue.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) ([A-Za-z_\/]+)$/);
    if (newFormatMatch) {
        const [, localDateTime, timezone] = newFormatMatch;
        // Parse local time with timezone to UTC
        // Create a Date that represents the local time in the given timezone
        const [datePart, timePart] = localDateTime.split(' ');
        const [year, month, day] = datePart.split('-').map(Number);
        const [hour, minute, second] = timePart.split(':').map(Number);
        
        // Use Intl to get UTC from local time + timezone
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            year: 'numeric', month: 'numeric', day: 'numeric',
            hour: 'numeric', minute: 'numeric', second: 'numeric',
            hour12: false
        });
        
        // Create a date in UTC, then adjust
        const utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
        
        // Get the offset for this timezone at this time
        const parts = formatter.formatToParts(utcDate);
        const getPart = (type) => parts.find(p => p.type === type).value;
        
        // Calculate the offset by comparing
        const localYear = Number(getPart('year'));
        const localMonth = Number(getPart('month'));
        const localDay = Number(getPart('day'));
        const localHour = Number(getPart('hour'));
        const localMinute = Number(getPart('minute'));
        
        // Simple approach: use the local time as if it's in the timezone
        // and construct a date, then get its UTC equivalent
        const testDate = new Date(year, month - 1, day, hour, minute, second);
        const utcString = testDate.toISOString();
        
        return {
            utc: utcString,
            timezone: timezone
        };
    }
    
    // Legacy format: "2026-02-08T08:18:30.317Z" or "2026-02-08 14:28:29+0800"
    // Keep as-is for backward compatibility
    return formattedValue;
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

// Helper to get latest timestamp from observations
function getLatestTimestamp(observations) {
    let latest = null;
    for (const obs of observations) {
        const ts = obs.updatedAt || obs.createdAt;
        if (ts && ts.utc) {
            if (!latest || ts.utc > latest) {
                latest = ts.utc;
            }
        }
    }
    return latest;
}

// The KnowledgeGraphManager class contains all operations to interact with the knowledge graph
export class KnowledgeGraphManager {
    memoryFilePath;
    cache;
    fileLock;
    searchIntegrator;  // Reference to searchIntegrator for index rebuild on data changes
    lastOperation;     // Track last operation for git commit message
    constructor(memoryFilePath, searchIntegrator = null) {
        this.memoryFilePath = memoryFilePath;
        this.cache = null;  // Simple memory cache: { data, mtime, timestamp }
        this.fileLock = null;  // File lock state
        this.isWindows = process.platform === 'win32';
        this.searchIntegrator = searchIntegrator;
        this.lastOperation = null;
    }

    // Set operation context for git commit message (auto-truncated)
    _setOperation(opType, ...details) {
        const detail = details.length > 0 ? ' ' + details.map(d => `"${d}"`).join(', ') : '';
        // Truncate to 50 chars max for commit message
        const full = `${opType}${detail}`;
        this.lastOperation = full.length > 50 ? full.substring(0, 47) + '...' : full;
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
                const migratedObservationsList = rawObservations.concat(migratedObservations);
                const migratedResult = {
                    entities: rawEntities.map(e => ({
                        name: e.name,
                        entityType: e.entityType,
                        definition: e.definition || "",
                        definitionSource: e.definitionSource === undefined || e.definitionSource === null ? null : String(e.definitionSource),
                        observationIds: e.observationIds || []
                    })),
                    observations: migratedObservationsList,
                    definitions: rawDefinitions,
                    relations: rawRelations,
                    _lastModified: getLatestTimestamp(migratedObservationsList)
                };
                this._updateCache(migratedResult);
                return migratedResult;
            }
            
            // New format: entities store observationIds (array of numbers)
            const newFormatObservations = rawObservations.map(o => ({
                id: o.id,
                content: o.content,
                createdAt: parseTimestampToStorage(o.createdAt),
                updatedAt: parseTimestampToStorage(o.updatedAt)
            }));
            const newFormatResult = {
                entities: rawEntities.map(e => ({
                    name: e.name,
                    entityType: e.entityType,
                    definition: e.definition || "",
                    definitionSource: e.definitionSource === undefined || e.definitionSource === null ? null : String(e.definitionSource),
                    observationIds: e.observationIds || []
                })),
                observations: newFormatObservations,
                definitions: rawDefinitions.map(d => ({
                    entityName: d.entityName,
                    content: d.content,
                    source: d.source || null,
                    createdAt: parseTimestampToStorage(d.createdAt),
                    updatedAt: parseTimestampToStorage(d.updatedAt)
                })),
                relations: rawRelations.map(r => ({
                    from: r.from,
                    to: r.to,
                    relationType: r.relationType
                })),
                _lastModified: getLatestTimestamp(newFormatObservations)
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
                    createdAt: o.createdAt || null,
                    updatedAt: o.updatedAt || null
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
        
        // Rebuild search index in background (non-blocking)
        if (this.searchIntegrator) {
            this.searchIntegrator.rebuildIndex();
        }
        
        // Auto-commit to git if enabled
        console.error('[Git] About to call autoCommit');
        await gitSync.autoCommit(this.memoryFilePath, this.lastOperation);
        console.error('[Git] autoCommit returned');
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
                            createdAt: getCurrentTimestamp(),
                            updatedAt: null  // 初始化时没有更新时间
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
        
        // Set operation context for git commit
        const newNames = newEntities.map(e => e.name);
        this._setOperation('createEntity', ...newNames);
        
        await this.saveGraph(graph);
        
        // Build result message
        const created = newEntities.length;
        const skipped = skippedEntities.length;
        
        const createdNames = newEntities.map(e => e.name).join(', ');
        let message = `Created ${created} entities: ${createdNames}`;
        if (skipped > 0) {
            message += `; Skipped duplicates: ${skippedEntities.join(', ')}`;
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
        
        // Set operation context for git commit
        const relDescs = newRelations.map(r => `${r.relationType}: ${r.from}→${r.to}`);
        this._setOperation('createRelation', ...relDescs);
        
        await this.saveGraph(graph);
        return newRelations;
    }
    /**
     * Add observations to entities
     * 
     * Supports two modes:
     * 1. Create new observations: provide 'contents' array
     *    - Deduplication: if content already exists, links to existing observation
     * 2. Link to existing observations: provide 'observationId' or 'observationIds'
     *    - For observation reuse across multiple entities
     * 
     * @param {Array} observations - Array of { entityName, contents?, observationId?, observationIds? }
     */
    async addObservation(observations) {
        const graph = await this.loadGraph();
        
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
            
            const newIds = [];
            const linkedIds = [];
            const newContents = [];
            
            // Mode 2: Link to existing observations by ID
            if (o.observationId !== undefined) {
                const obs = graph.observations.find(obs => obs.id === o.observationId);
                if (!obs) {
                    throw new Error(`Observation with ID "${o.observationId}" not found`);
                }
                if (!entity.observationIds.includes(o.observationId)) {
                    entity.observationIds.push(o.observationId);
                    linkedIds.push(o.observationId);
                }
            }
            
            if (o.observationIds !== undefined) {
                for (const obsId of o.observationIds) {
                    const obs = graph.observations.find(obs => obs.id === obsId);
                    if (!obs) {
                        throw new Error(`Observation with ID "${obsId}" not found`);
                    }
                    if (!entity.observationIds.includes(obsId)) {
                        entity.observationIds.push(obsId);
                        linkedIds.push(obsId);
                    }
                }
            }
            
            // Mode 1: Create new observations by content (only if no observationId(s) provided)
            if (o.contents && o.observationId === undefined && !o.observationIds) {
                for (const content of o.contents) {
                    // Check if same observation already exists (deduplication)
                    const existingObs = graph.observations.find(obs => obs.content === content);
                    
                    if (existingObs) {
                        // Add existing observation ID if not already linked
                        if (!entity.observationIds.includes(existingObs.id)) {
                            entity.observationIds.push(existingObs.id);
                            linkedIds.push(existingObs.id);
                        }
                    } else {
                        // Create new centralized observation
                        const newId = ++maxObsId;
                        graph.observations.push({
                            id: newId,
                            content: content,
                            createdAt: getCurrentTimestamp(),
                            updatedAt: null  // 初始化时没有更新时间
                        });
                        entity.observationIds.push(newId);
                        newIds.push(newId);
                        newContents.push(content);
                    }
                }
            }
            
            results.push({
                entityName: o.entityName,
                addedObservations: newContents.length > 0 ? newContents : undefined,
                addedObservationIds: newIds.length > 0 ? newIds : undefined,
                linkedObservationIds: linkedIds.length > 0 ? linkedIds : undefined
            });
        }
        
        // Set operation context for git commit
        this._setOperation('addObservation', ...results.map(r => r.entityName));
        
        await this.saveGraph(graph);
        return results;
    }
    async deleteEntity(entityNames) {
        const graph = await this.loadGraph();
        
        // Capture deleted entities and relations for potential undo
        const deletedEntities = graph.entities.filter(e => entityNames.includes(e.name));
        const deletedRelations = graph.relations.filter(r => entityNames.includes(r.from) || entityNames.includes(r.to));
        
        graph.entities = graph.entities.filter(e => !entityNames.includes(e.name));
        graph.relations = graph.relations.filter(r => !entityNames.includes(r.from) && !entityNames.includes(r.to));
        
        // Set operation context for git commit
        this._setOperation('deleteEntity', ...entityNames);
        
        await this.saveGraph(graph);
        
        return {
            deletedEntities,
            deletedRelations
        };
    }
    async unlinkObservation(observationIds, entityNames) {
        const graph = await this.loadGraph();
        const warnings = [];
        const results = [];
        
        const obsIds = Array.isArray(observationIds) ? observationIds : [observationIds];
        const entNames = Array.isArray(entityNames) ? entityNames : (entityNames ? [entityNames] : []);
        
        for (const obsId of obsIds) {
            const obs = graph.observations.find(o => o.id === obsId);
            
            if (!obs) {
                warnings.push(`Observation ID ${obsId} not found`);
                results.push({
                    observationId: obsId,
                    removedFrom: [],
                    notFoundEntities: entNames,
                    message: "Observation not found"
                });
                continue;
            }
            
            const removedFrom = [];
            const notFoundEntities = [];
            
            for (const entityName of entNames) {
                const entity = graph.entities.find(e => e.name === entityName);
                
                if (!entity) {
                    notFoundEntities.push(entityName);
                    continue;
                }
                
                if (!entity.observationIds.includes(obs.id)) {
                    warnings.push(`Observation ID ${obsId} not linked to entity "${entityName}"`);
                    continue;
                }
                
                // Remove link only (observation stays as orphan)
                entity.observationIds = entity.observationIds.filter(id => id !== obs.id);
                removedFrom.push(entityName);
            }
            
            results.push({
                observationId: obs.id,
                originalContent: obs.content,
                removedFrom: removedFrom,
                notFoundEntities: notFoundEntities,
                // Full observation data for potential undo
                observationData: {
                    id: obs.id,
                    content: obs.content,
                    createdAt: obs.createdAt,
                    updatedAt: obs.updatedAt
                }
            });
            
            if (notFoundEntities.length > 0) {
                warnings.push(`Entities not found for observation ID ${obsId}: ${notFoundEntities.join(', ')}`);
            }
        }
        
        // Set operation context for git commit
        const opDetails = obsIds.map(id => `obs#${id}`);
        this._setOperation('unlinkObservation', ...opDetails);
        
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
        
        // Set operation context for git commit
        const relDescs = relations.map(r => `${r.from}→${r.to}`);
        this._setOperation('deleteRelation', ...relDescs);
        
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

                warnings.push(`Skipped observation ${obsId} - still referenced by: ${referencingEntities.map(e => e.name).join(', ')}. Use unlinkObservation first.`);
            }
        }

        // Set operation context for git commit
        this._setOperation('recycleObservation', `deleted:${deleted.length},skipped:${skipped.length}`);

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
        
        // Set operation context for git commit
        this._setOperation('setDefinition', entityName);
        
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
        
        // Set operation context for git commit
        const updatedNames = updates.map(u => u.entityName);
        this._setOperation('updateNode', ...updatedNames);
        
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
            createdAt: obs.createdAt || null,
            updatedAt: obs.updatedAt || null
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
        observation.updatedAt = getCurrentTimestamp();  // Track when observation was updated
        
        // Find all entities that reference this observation
        const linkedEntities = graph.entities
            .filter(e => e.observationIds?.includes(observationId))
            .map(e => e.name);
        
        // Set operation context for git commit
        const contentPreview = newContent.length > 20 ? newContent.substring(0, 17) + '...' : newContent;
        this._setOperation('updateObservation', String(observationId), contentPreview);
        
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
                    createdAt: formatTimestamp(obs.createdAt)?.value || null,
                    updatedAt: formatTimestamp(obs.updatedAt)?.value || null
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
            createdAt: o.createdAt || null,
            updatedAt: o.updatedAt || null
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
                    createdAt: observation.createdAt || null,
                    updatedAt: observation.updatedAt || null
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
    definitionSource: z.string().optional().describe("Source of the definition - prefer URL, filename, or book title"),
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
    version: VERSION,
});
// Console buffer for getConsole tool (with deduplication)
const consoleBuffer = [];
const seenMessages = new Set();
// Override console.error to capture messages
const originalConsoleError = console.error;
console.error = (...args) => {
    const message = args.join(' ').trim();
    if (!seenMessages.has(message)) {
        seenMessages.add(message);
        consoleBuffer.push(message);
    }
    originalConsoleError.apply(console, args);
};
// Register getConsole tool
server.registerTool("getConsole", {
    title: "Get Console",
    description: "Retrieve buffered server logs and recent git commits.",
    inputSchema: {
        easterEgg: z.boolean().optional().default(false).describe("Easter egg activated")
    },
    outputSchema: {}
}, async ({ easterEgg }) => {
    const lines = [];
    
    // Add buffered messages
    for (const msg of consoleBuffer) {
        lines.push(msg);
    }
    
    // Get recent git log if git sync is enabled and initialized
    if (gitSync.isEnabled() && gitSync.initialized) {
        // Format: %h %an <%ae> %s (short hash, author name, email, subject)
        const logResult = await gitSync.execGit(['log', '--format=%h %an <%ae> %s', '-10'], gitSync.memoryDir);
        if (logResult.success) {
            const commits = logResult.output.trim().split('\n');
            for (const commit of commits) {
                lines.push(`[Git] ${commit}`);
            }
        }
    }
    
    // Easter egg for 乐正绫's 11th birthday
    if (easterEgg) {
        lines.push('');
        lines.push('🎉 "乐正司百曲，绫动万年红" —— 阿绫11周年生日快乐！');
    }
    
    return {
        content: [{ type: "text", text: lines.join('\n') }],
        structuredContent: {}
    };
});
// Register create_entities tool
server.registerTool("createEntity", {
    title: "Create Entity",
    description: "Create multiple entities with names, types, and definitions. Skips duplicate entities - use updateNode to modify existing ones.",
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
    description: "Create multiple relations between entities. Use active voice for relation types (e.g., 'includes', 'relates to', 'follows').",
    inputSchema: {
        relations: z.array(RelationSchema)
    },
    outputSchema: {
        relations: z.array(RelationSchema)
    }
}, async ({ relations }) => {
    const result = await knowledgeGraphManager.createRelation(relations);
    return {
        content: [{ type: "text", text: `Created ${result.length} relations` }],
        structuredContent: { relations: result }
    };
});
// Register add_observations tool
 server.registerTool("addObservation", {
    title: "Add Observation",
    description: "Add observations to multiple entities. Supports two modes:\n1. Create: provide 'contents' array to create new observations (deduplication applies)\n2. Link: provide 'observationId' or 'observationIds' to link to existing observations\n\nMode selection is determined by which fields are provided (mutually exclusive per item).",
    inputSchema: {
        // 使用 discriminatedUnion 处理互斥字段：contents 和 observationId(s) 二选一
        observations: z.array(z.discriminatedUnion('mode', [
            // Mode 1: Create new observations by content
            z.object({
                mode: z.literal('create'),
                entityName: z.string().describe("The name of the entity to add the observations to"),
                contents: z.array(z.string()).describe("Create new observations with these contents (deduplication applies)")
            }),
            // Mode 2: Link to existing observation by ID
            z.object({
                mode: z.literal('link-single'),
                entityName: z.string().describe("The name of the entity to add the observations to"),
                observationId: z.number().describe("Link to an existing observation by ID (for reuse)")
            }),
            // Mode 3: Link to multiple existing observations by IDs
            z.object({
                mode: z.literal('link-multi'),
                entityName: z.string().describe("The name of the entity to add the observations to"),
                observationIds: z.array(z.number()).describe("Link to multiple existing observations by ID (for reuse)")
            })
        ]))
    },
    outputSchema: {
        results: z.array(z.object({
            entityName: z.string(),
            addedObservations: z.array(z.string()).optional(),
            addedObservationIds: z.array(z.number()).optional(),
            linkedObservationIds: z.array(z.number()).optional()
        }))
    }
 }, async ({ observations }) => {
    // Transform discriminated union format back to internal format
    const internalObs = observations.map(o => ({
        entityName: o.entityName,
        contents: o.mode === 'create' ? o.contents : undefined,
        observationId: o.mode === 'link-single' ? o.observationId : undefined,
        observationIds: o.mode === 'link-multi' ? o.observationIds : undefined
    }));
    const result = await knowledgeGraphManager.addObservation(internalObs);
    const allNewIds = result.flatMap(r => r.addedObservationIds || []);
    const allLinkedIds = result.flatMap(r => r.linkedObservationIds || []);
    const msgParts = [];
    if (allNewIds.length > 0) msgParts.push(`new obs IDs: [${allNewIds.join(', ')}]`);
    if (allLinkedIds.length > 0) msgParts.push(`linked IDs: [${allLinkedIds.join(', ')}]`);
    return {
        content: [{ type: "text", text: `Added observations to ${result.length} entities, ${msgParts.join(', ')}` }],
        structuredContent: { results: result }
    };
 });
// Register delete_entities tool
server.registerTool("deleteEntity", {
    title: "Delete Entity",
    description: "Delete multiple entities and all their associated relations. Returns full entity JSON for potential undo.",
    inputSchema: {
        entityNames: z.array(z.string()).describe("An array of entity names to delete")
    },
    outputSchema: {
        success: z.boolean(),
        message: z.string(),
        deletedEntities: z.array(z.object({
            name: z.string(),
            entityType: z.string(),
            definition: z.string(),
            definitionSource: z.string().nullable().optional(),
            observationIds: z.array(z.number())
        })),
        deletedRelations: z.array(z.object({
            from: z.string(),
            to: z.string(),
            relationType: z.string()
        }))
    }
}, async ({ entityNames }) => {
    const result = await knowledgeGraphManager.deleteEntity(entityNames);
    const names = result.deletedEntities.map(e => e.name).join(', ');
    return {
        content: [{ type: "text", text: `Deleted entities: ${names}` }],
        structuredContent: { 
            success: true, 
            message: `Deleted entities: ${names}`,
            deletedEntities: result.deletedEntities,
            deletedRelations: result.deletedRelations
        }
    };
});
// Register unlink_observations tool
server.registerTool("unlinkObservation", {
    title: "Unlink Observation",
    description: "Remove observation links from entities by observation ID. Returns full observation content for potential undo.",
    inputSchema: {
        observationIds: z.array(z.number()).describe("Observation IDs to unlink"),
        entityNames: z.array(z.string()).describe("Entity names to unlink from (omit to unlink from all)")
    },
    outputSchema: {
        success: z.boolean(),
        warnings: z.array(z.string()),
        results: z.array(z.object({
            observationId: z.number(),
            originalContent: z.string(),
            removedFrom: z.array(z.string()),
            notFoundEntities: z.array(z.string()),
            observationData: z.object({
                id: z.number(),
                content: z.string(),
                createdAt: z.any(),
                updatedAt: z.any()
            })
        }))
    }
}, async ({ observationIds, entityNames }) => {
    const result = await knowledgeGraphManager.unlinkObservation(observationIds, entityNames);
    const unlinkedIds = result.results.filter(r => r.observationId).map(r => r.observationId);
    const contents = result.results.filter(r => r.originalContent).map(r => `"${r.originalContent.substring(0, 20)}..."`);
    const warningText = result.warnings.length > 0 
        ? `Warnings: ${result.warnings.join('; ')}` 
        : "";
    return {
        content: [{ type: "text", text: `Unlinked observations: [${unlinkedIds.join(', ')}]${warningText ? ' ' + warningText : ''}` }],
        structuredContent: result
    };
});
// Register delete_relations tool
server.registerTool("deleteRelation", {
    title: "Delete Relation",
    description: "Delete multiple relations from the knowledge graph.",
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
        content: [{ type: "text", text: `Deleted ${relations.length} relations` }],
        structuredContent: { success: true, message: `Deleted ${relations.length} relations` }
    };
});
// Register recycle_observation tool
server.registerTool("recycleObservation", {
    title: "Recycle Observation",
    description: "Permanently delete observations. Orphaned observations are deleted directly. Referenced observations are skipped unless force=true. Returns original content for potential undo.",
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
    description: "Read the entire knowledge graph with all entities, observations, and relations. Use sparingly as it returns all data. Set time=true to include timestamps.",
    inputSchema: {
        time: z.boolean().optional().default(false).describe("Include observation timestamps (createdAt)")
    },
    outputSchema: {
        entities: z.array(EntityOutputSchema),
        observations: z.array(z.object({
            id: z.number(),
            content: z.string(),
            createdAt: z.string().nullable(),
            updatedAt: z.string().nullable()
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
    description: "Search entities using BM25 + Fuse.js hybrid search with relevance scoring. Returns sorted results with related entities and observations. Use basicFetch=true for traditional keyword matching.",
    inputSchema: {
        query: z.string().describe("The search query to match against entity names, types, definitions, and observation content"),
        time: z.boolean().optional().default(false).describe("Include observation timestamps (createdAt)"),
        basicFetch: z.boolean().optional().default(false).describe("Use traditional keyword matching instead of hybrid search"),
        limit: z.number().optional().default(15).describe("Maximum number of entities to return (default: 15)"),
        maxObservationsPerEntity: z.number().optional().default(5).describe("Maximum observations per entity (default: 5)"),
        totalMultiplier: z.number().optional().default(3).describe("Total output limit multiplier: limit × maxObservationsPerEntity × totalMultiplier (default: 3)"),
        bm25Weight: z.number().optional().default(0.7).describe("Weight for BM25 ranking (0-1, default: 0.7)"),
        fuzzyWeight: z.number().optional().default(0.3).describe("Weight for Fuse.js fuzzy matching (0-1, default: 0.3)"),
        minScore: z.number().optional().default(0.1).describe("Minimum relevance score threshold (default: 0.1)")
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
            createdAt: z.string().nullable(),
            updatedAt: z.string().nullable()
        }))
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

    // 直接使用 searchIntegrator 返回的结果，已经包含正确的限制
    // - entities: 最多 limit 个
    // - observations: 最多 limit × maxObservationsPerEntity 个
    // - relations: 最多 limit × 2 个
    const limitedResult = {
        entities: cleanResult.entities,
        observations: cleanResult.observations,
        relations: cleanResult.relations
    };

    return {
        content: [{ type: "text", text: JSON.stringify(limitedResult, null, 2) }],
        structuredContent: limitedResult
    };
});
// Register open_nodes tool
server.registerTool("readNode", {
    title: "Read Node",
    description: "Get detailed entity information including observations and relations. Includes inline target entity details. Set time=true to include timestamps.",
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
            createdAt: z.string().nullable(),
            updatedAt: z.string().nullable()
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
    description: "Update multiple entities and their observations. Shared observations use copy-on-write to preserve other entity references.",
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
    const updatedNames = results.map(r => r.entityName).join(', ');
    return {
        content: [{ type: "text", text: `Updated ${results.length} entities: ${updatedNames}` }],
        structuredContent: { results }
    };
});
// Register orphan_observations tool
server.registerTool("getOrphanObservation", {
    title: "Get Orphan Observation",
    description: "Find observations not referenced by any entity. These are safe to permanently delete with recycleObservation.",
    inputSchema: {
        time: z.boolean().optional().default(false).describe("Include observation timestamps (createdAt)")
    },
    outputSchema: {
        orphanObservations: z.array(z.object({
            id: z.number(),
            content: z.string(),
            createdAt: z.string().nullable(),
            updatedAt: z.string().nullable()
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
    description: "Get observation details by IDs. Returns content and timestamp.",
    inputSchema: {
        ids: z.array(z.number()).describe("Array of observation IDs to retrieve"),
        time: z.boolean().optional().default(false).describe("Include observation timestamps (createdAt)")
    },
    outputSchema: {
        observations: z.array(z.object({
            id: z.number(),
            content: z.string(),
            createdAt: z.string().nullable(),
            updatedAt: z.string().nullable()
        }))
    }
}, async ({ ids, time }) => {
    const observations = await knowledgeGraphManager.readObservation(ids);
    
    // Conditionally include createdAt
    const result = observations.map(o => ({
        id: o.id,
        content: o.content,
        createdAt: time ? formatTimestamp(o.createdAt)?.value : null,
        updatedAt: time ? formatTimestamp(o.updatedAt)?.value : null
    }));
    
    return {
        content: [{ type: "text", text: JSON.stringify({ observations: result }, null, 2) }],
        structuredContent: { observations: result }
    };
});
// Register update_observations tool (batch)
server.registerTool("updateObservation", {
    title: "Update Observation",
    description: "Batch update observations by ID. Changes propagate to all linked entities. For copy-on-write behavior, use updateNode instead.",
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
    
    const updatedIds = formattedResults.map(r => r.observationId).join(', ');
    return {
        content: [{ type: "text", text: `Updated observations: [${updatedIds}]` }],
        structuredContent: { results: formattedResults }
    };
});
// Register read_nodes tool
server.registerTool("listNode", {
    title: "List Node",
    description: "List all entity names, types, and definitions. Use readNode for detailed observations and relations.",
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
        content: [{ type: "text", text: JSON.stringify(nodes) }],
        structuredContent: { nodes }
    };
});
// Register howWork tool
server.registerTool("howWork", {
    title: "How It Works",
    description: "Get the recommended workflow for using the knowledge graph system.",
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
/**
 * Create and initialize managers (for programmatic use / visualizer)
 * Returns { knowledgeGraphManager, searchIntegrator }
 */
export async function createManagers(options = {}) {
    const memoryPath = options.memoryPath || await ensureMemoryFilePath();
    
    // Ensure the memory directory exists
    const memoryDir = path.dirname(memoryPath);
    try {
        await fs.mkdir(memoryDir, { recursive: true });
    } catch (err) {
        if (err.code !== 'EEXIST' && err.code !== 'EPERM') {
            throw err;
        }
    }
    
    // Initialize git sync if enabled
    if (gitSync.isEnabled()) {
        await gitSync.initRepo(memoryDir);
    }
    
    const knowledgeGraphManager = new KnowledgeGraphManager(memoryPath);
    const searchIntegrator = new SearchIntegrator(knowledgeGraphManager);
    knowledgeGraphManager.searchIntegrator = searchIntegrator;
    
    return { knowledgeGraphManager, searchIntegrator };
}

async function main() {
    // Initialize managers
    const { knowledgeGraphManager: manager, searchIntegrator: si } = await createManagers();
    knowledgeGraphManager = manager;
    searchIntegrator = si;
    
    // Load graph first for stats display
    const graph = await knowledgeGraphManager.loadGraph();
    const entityCount = graph.entities.length;
    const observationCount = graph.observations.length;
    const relationCount = graph.relations.length;
    const lastUpdated = graph._lastModified 
        ? new Date(graph._lastModified).toISOString().replace('T', ' ').substring(0, 19) + ' UTC'
        : 'N/A';
    
    // Build index synchronously first to get size for stats display
    await searchIntegrator.ensureIndex();
    const indexSize = searchIntegrator.getIndexSize();
    const indexSizeStr = indexSize >= 1024 * 1024 
        ? `${(indexSize / (1024 * 1024)).toFixed(2)} MB`
        : indexSize >= 1024 
            ? `${(indexSize / 1024).toFixed(2)} KB`
            : `${indexSize} B`;
    
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[MCP Server] MemFS v${VERSION} running on stdio`);
    console.error(`[Stats] ${entityCount} entities | ${observationCount} observations | ${relationCount} relations | last updated ${lastUpdated}`);
    console.error(`[Stats] Index size: ${indexSizeStr}`);
}
main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});