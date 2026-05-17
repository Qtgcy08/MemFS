#!/usr/bin/env node
import fs from 'fs';

const filePath = process.argv[2] || './private_test_usages/memory.jsonl';
const outputPath = process.argv[3] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'memfs_export.md');

const DAYS = ['Sun.', 'Mon.', 'Tue.', 'Wed.', 'Thu.', 'Fri.', 'Sat.'];
const pad = (n) => String(n).padStart(2, '0');

function nowFormatted() {
    const now = new Date();
    const y = now.getFullYear();
    const M = pad(now.getMonth() + 1);
    const d = pad(now.getDate());
    const h = pad(now.getHours());
    const m = pad(now.getMinutes());
    const dow = DAYS[now.getDay()];
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return `${y}-${M}-${d} ${h}:${m} ${dow} ${tz}`;
}

function formatWithTz(utcStr, timezone) {
    const tz = timezone || 'Asia/Shanghai';
    const date = new Date(utcStr);
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    });
    const parts = fmt.formatToParts(date);
    const get = (type) => parts.find(p => p.type === type).value;
    const utcDate = new Date(utcStr);
    const dow = DAYS[utcDate.getUTCDay()];
    // For display, use the formatted local time
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} ${dow} ${tz}`;
}

function parseTs(ts) {
    if (!ts) return null;
    if (typeof ts === 'object' && ts.utc) {
        return { utc: ts.utc, tz: ts.timezone };
    }
    if (typeof ts === 'string') {
        return { utc: ts, tz: 'UTC' };
    }
    return null;
}

function tsToDate(ts) {
    if (!ts) return null;
    const p = parseTs(ts);
    return p ? new Date(p.utc) : null;
}

function formatTs(ts) {
    if (!ts) return null;
    const p = parseTs(ts);
    return p ? formatWithTz(p.utc, p.tz) : String(ts);
}

const content = fs.readFileSync(filePath, 'utf-8');
const lines = content.trim().split('\n').filter(Boolean);

const entities = [];
const observations = [];
const relations = [];

for (const line of lines) {
    try {
        const obj = JSON.parse(line);
        if (obj.type === 'entity') {
            entities.push({
                name: obj.name,
                entityType: obj.entityType || '',
                definition: obj.definition || '',
                definitionSource: obj.definitionSource || null,
                observationIds: obj.observationIds || []
            });
        } else if (obj.type === 'observation') {
            observations.push({
                id: obj.id,
                content: obj.content,
                createdAt: obj.createdAt || null,
                updatedAt: obj.updatedAt || null
            });
        } else if (obj.type === 'relation') {
            if (obj.from && obj.to) {
                relations.push({
                    from: obj.from,
                    to: obj.to,
                    relationType: obj.relationType || ''
                });
            }
        }
    } catch {
        // skip malformed lines
    }
}

const entityCount = entities.length;
const obsCount = observations.length;
const relCount = relations.length;

// Build entity index (name -> serial)
const entityIndex = {};
entities.forEach((e, i) => {
    entityIndex[e.name] = i + 1;
});

// Observation lookup by id
const obsById = {};
observations.forEach(o => {
    obsById[o.id] = o;
});

// Entity -> observation details (for each entity, list its obs ids and contents)
function getEntityObservations(entity) {
    return entity.observationIds
        .map(id => obsById[id])
        .filter(Boolean);
}

// For linkedWith: find which other entities share this observation
function findSharingEntities(obsId, currentEntityName) {
    const sharing = [];
    entities.forEach(e => {
        if (e.name !== currentEntityName && e.observationIds.includes(obsId)) {
            sharing.push(entityIndex[e.name]);
        }
    });
    return sharing;
}

// Per-entity observation count
const entityObsCounts = entities.map((e, i) => ({
    name: e.name,
    serial: i + 1,
    count: getEntityObservations(e).length
}));

// Per-entity relation count
const entityRelCounts = entities.map((e, i) => ({
    name: e.name,
    serial: i + 1,
    count: relations.filter(r => r.from === e.name || r.to === e.name).length
}));

// Sort by count descending, take top 5
const topObs = [...entityObsCounts].sort((a, b) => b.count - a.count).slice(0, 5);
const topRel = [...entityRelCounts].sort((a, b) => b.count - a.count).slice(0, 5);

// Average stats
const avgObs = entityCount > 0 ? (obsCount / entityCount).toFixed(2) : '0';
const avgRel = entityCount > 0 ? (relCount / entityCount).toFixed(2) : '0';

// Earliest/latest observation
let earliestObs = null;
let latestObs = null;

for (const o of observations) {
    const cDate = tsToDate(o.createdAt);
    const uDate = tsToDate(o.updatedAt);
    const latestDate = uDate && (!cDate || uDate > cDate) ? uDate : cDate;
    if (cDate) {
        if (!earliestObs || cDate < tsToDate(earliestObs.createdAt)) {
            earliestObs = o;
        }
    }
    if (latestDate) {
        if (!latestObs || latestDate > tsToDate(latestObs.updatedAt || latestObs.createdAt)) {
            latestObs = o;
        }
    }
}

// ---- Generate output ----
let md = '';

// Header
md += '# MemFS Knowledge Export\n';
md += `> version: converter 1.0\n`;
md += `> Export time: ${nowFormatted()}\n`;

// Info section
md += `## Info\n`;
md += `entities: ${entityCount} | observations: ${obsCount} | relations: ${relCount}\n`;
md += '```text\n';
md += `Observations per entity: ${avgObs}\n`;
md += `Relations per entity: ${avgRel}\n`;
md += `Max observations: ${topObs.map(e => `"${e.name}"[${e.serial}](${e.count})`).join(', ')}\n`;
md += `Max relations: ${topRel.map(e => `"${e.name}"[${e.serial}](${e.count})`).join(', ')}\n`;
if (earliestObs) {
    const cTs = formatTs(earliestObs.createdAt);
    const contentPreview = earliestObs.content.length > 50
        ? earliestObs.content.substring(0, 50) + '……'
        : earliestObs.content;
    md += `Earliest observation: [${earliestObs.id}]"${contentPreview}" (createdAt: ${cTs})\n`;
}
if (latestObs) {
    const latestCreated = formatTs(latestObs.createdAt);
    const latestUpdated = formatTs(latestObs.updatedAt);
    const latestLabel = latestUpdated && latestObs.updatedAt
        ? `createdAt/updatedAt: ${latestCreated} / ${latestUpdated}`
        : `createdAt: ${latestCreated}`;
    const contentPreview = latestObs.content.length > 50
        ? latestObs.content.substring(0, 50) + '……'
        : latestObs.content;
    md += `Latest observation: [${latestObs.id}]"${contentPreview}" (${latestLabel})\n`;
}
md += '```\n';

// Entities section
md += `# Entities\n`;

for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    const serial = i + 1;
    md += `## 『${e.name}』 *[${serial}]*\n`;
    md += `> Type: ${e.entityType || ''}\n`;
    md += `> Definition: ${e.definition || ''}\n`;
    if (e.definitionSource !== null && e.definitionSource !== '') {
        md += `> Source: ${e.definitionSource}\n`;
    }

    // Observations for this entity
    const entityObs = getEntityObservations(e);
    md += `### Observations\n`;
    entityObs.forEach((obs, oi) => {
        const obsNum = oi + 1;
        const safeContent = obs.content.replace(/`/g, '\uFF40');
        md += `*[${obsNum}]*: **${safeContent}**\n`;
        const cTs = formatTs(obs.createdAt);
        const uTs = formatTs(obs.updatedAt);
        if (cTs) {
            let line = `createdAt: ${cTs}`;
            if (uTs) {
                line += ` updatedAt: ${uTs}`;
            }
            md += line + '\n';
        }
        // Check if shared with other entities
        const sharing = findSharingEntities(obs.id, e.name);
        if (sharing.length > 0) {
            md += `linkedWith: ${sharing.map(s => `[${s}]`).join(', ')}\n`;
        }
    });

    // Relations for this entity
    const entityRels = relations.filter(r => r.from === e.name || r.to === e.name);
    if (entityRels.length > 0) {
        md += `### Relations\n`;
        entityRels.forEach(r => {
            if (r.to === e.name) {
                const fromSerial = entityIndex[r.from];
                const fromTag = fromSerial ? `[${fromSerial}]` : '[?]';
                md += `"${r.from}"${fromTag} -> ${r.relationType}\n`;
            } else {
                const toSerial = entityIndex[r.to];
                const toTag = toSerial ? `[${toSerial}]` : '[?]';
                md += `${r.relationType} "${r.to}"${toTag}\n`;
            }
        });
    }
}

fs.writeFileSync(outputPath, md, 'utf-8');
console.error(`Exported to ${outputPath}`);
