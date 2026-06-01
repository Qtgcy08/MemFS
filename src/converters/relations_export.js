#!/usr/bin/env node
import fs from 'fs';

const filePath = process.argv[2] || './private_test_usages/memory.jsonl';

const CF = {
    bg: '#161616',
    fg: '#f2f4f8',
    sel0: '#2a2a2a',
    sel1: '#525253',
    white: '#dfdfe0',
};

function hslToHex(h, s, l) {
    h /= 360;
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
        const k = (n + h * 12) % 12;
        const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(c * 255).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

function genColor(i) {
    const hue = (i * 137.508) % 360;
    const sat = 80 + (i % 3) * 8;
    const light = 60 + (Math.floor(i / 3) % 3) * 8;
    return hslToHex(hue, sat, light);
}

function blend(hex1, hex2, ratio) {
    const r1 = parseInt(hex1.slice(1, 3), 16);
    const g1 = parseInt(hex1.slice(3, 5), 16);
    const b1 = parseInt(hex1.slice(5, 7), 16);
    const r2 = parseInt(hex2.slice(1, 3), 16);
    const g2 = parseInt(hex2.slice(3, 5), 16);
    const b2 = parseInt(hex2.slice(5, 7), 16);
    const r = Math.round(r1 + (r2 - r1) * ratio);
    const g = Math.round(g1 + (g2 - g1) * ratio);
    const b = Math.round(b1 + (b2 - b1) * ratio);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function dimColor(hex) {
    return blend(CF.bg, hex, 0.3);
}

function esc(name) {
    return name.replace(/"/g, '\\"');
}



const content = fs.readFileSync(filePath, 'utf-8');
const lines = content.trim().split('\n').filter(Boolean);

const entityTypes = {};
const groups = {};

for (const line of lines) {
    try {
        const obj = JSON.parse(line);
        if (obj.type === 'entity' && obj.name) {
            if (!entityTypes[obj.name]) {
                entityTypes[obj.name] = obj.entityType || 'unknown';
            }
        } else if (obj.type === 'relation') {
            const { from, to, relationType } = obj;
            if (from === to) continue;
            if (!entityTypes[from]) entityTypes[from] = 'unknown';
            if (!entityTypes[to]) entityTypes[to] = 'unknown';
            const key = [from, to].sort().join('\x00');
            if (!groups[key]) {
                groups[key] = { a: from, b: to, forward: [], reverse: [] };
            }
            const g = groups[key];
            if (from === g.a && to === g.b) {
                g.forward.push(relationType);
            } else {
                g.reverse.push(relationType);
            }
        }
    } catch {
        // skip malformed lines
    }
}

const uniqueTypes = [...new Set(Object.values(entityTypes))].sort();
const typeColor = {};
uniqueTypes.forEach((t, i) => {
    typeColor[t] = genColor(i);
});
if (!typeColor['unknown']) typeColor['unknown'] = CF.sel1;

const entityColor = {};
for (const name of Object.keys(entityTypes)) {
    const et = entityTypes[name];
    entityColor[name] = typeColor[et] || CF.sel1;
}

const edgeList = Object.values(groups);

// Stats
const entityCount = Object.keys(entityTypes).length;
const typeCount = uniqueTypes.length;
const relationCount = edgeList.reduce((sum, g) => sum + g.forward.length + g.reverse.length, 0);
const relTypeSet = new Set();
for (const g of edgeList) {
    for (const t of g.forward) relTypeSet.add(t);
    for (const t of g.reverse) relTypeSet.add(t);
}
const relTypeCount = relTypeSet.size;
const now = new Date();
const days = ['Sun.', 'Mon.', 'Tue.', 'Wed.', 'Thu.', 'Fri.', 'Sat.'];
const pad = (n) => String(n).padStart(2, '0');
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const exportTime = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} ${days[now.getDay()]} ${tz}`;

let dot = 'digraph KnowledgeGraph {\n';
dot += '    bgcolor="#161616";\n';
dot += '    rankdir=LR;\n';
dot += '    newrank=true;\n    splines=ortho;\n';
dot += '    node [shape=box, style="filled,rounded", fontcolor="#f2f4f8", fillcolor="#2a2a2a", fontsize=22, fontname="Noto Sans SC"];\n';
dot += '    edge [color="#525253"];\n\n';
const declared = new Set();
for (const { a, b } of edgeList) {
    for (const name of [a, b]) {
        if (!declared.has(name)) {
            declared.add(name);
            const col = entityColor[name] || CF.sel1;
            const fill = dimColor(col);
            dot += `    "${esc(name)}" [fillcolor="${fill}", color="${col}"];\n`;
        }
    }
}

dot += '\n';
dot += '    subgraph cluster_legend {\n';
dot += '        rank=source;\n';
dot += '        style=filled;\n';
dot += '        fillcolor="#161616";\n';
dot += '        color="#484848";\n';
dot += '        fontcolor="#f2f4f8";\n';
dot += '        fontname="Noto Sans SC";\n';
dot += '        label="";\n';
dot += '        info [shape=box, style="filled,rounded", fillcolor="#252525", color="#484848", fontcolor="#f2f4f8", fontname="Noto Sans SC", margin=0.18, label=<\n';
dot += `            <TABLE BORDER="0" CELLBORDER="0" CELLSPACING="3" CELLPADDING="4">\n`;
dot += `                <TR><TD><FONT POINT-SIZE="13" COLOR="#78a9ff"><B>MemFS 知识图谱</B></FONT></TD></TR>\n`;
dot += `                <TR><TD><FONT POINT-SIZE="9" COLOR="#f2f4f8"><FONT COLOR="#3ddbd9"><B>${entityCount}</B></FONT> entities | <FONT COLOR="#3ddbd9"><B>${typeCount}</B></FONT> types</FONT></TD></TR>\n`;
dot += `                <TR><TD><FONT POINT-SIZE="9" COLOR="#f2f4f8"><FONT COLOR="#3ddbd9"><B>${relationCount}</B></FONT> relations | <FONT COLOR="#3ddbd9"><B>${relTypeCount}</B></FONT> relation types</FONT></TD></TR>\n`;
dot += `                <TR><TD><FONT POINT-SIZE="7" COLOR="#7b7c7e">exported ${exportTime}</FONT></TD></TR>\n`;
dot += `            </TABLE>\n`;
dot += '        >];\n';
dot += '    }\n\n';

for (const { a, b, forward, reverse } of edgeList) {
    const col = entityColor[a] || CF.sel1;
    for (const _rt of forward) {
        dot += `    "${esc(b)}" -> "${esc(a)}" [color="${col}"];\n`;
    }
    for (const _rt of reverse) {
        dot += `    "${esc(a)}" -> "${esc(b)}" [color="${col}"];\n`;
    }
}

dot += '}\n';
console.log(dot);
