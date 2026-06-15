import { parentPort, workerData } from 'worker_threads';
import { promises as fs } from 'fs';

const BM25_K1 = 1.2;
const BM25_B = 0.5;

// --- BM25 index (self-contained) ---

function generateNGram(str, n) {
    if (str.length < n) return str.length > 0 ? [str] : [];
    const t = [];
    for (let i = 0; i <= str.length - n; i++) t.push(str.substring(i, i + n));
    return t;
}

function cleanText(text) {
    if (!text || typeof text !== 'string') return '';
    return text.replace(/[\u3000-\u303f\uff00-\uffef!@#$%^&*()=\[\]{}|;':",.\/<>?`~\\]/g, '').replace(/\s+/g, ' ').trim();
}

function tokenizeForIndex(text) {
    const cleaned = cleanText(text);
    if (!cleaned) return [];
    const tokens = new Set();
    tokens.add(cleaned);
    if (cleaned.length >= 3) generateNGram(cleaned, 2).forEach(x => tokens.add(x));
    if (cleaned.length >= 4) generateNGram(cleaned, 3).forEach(x => tokens.add(x));
    if (cleaned.length >= 5) generateNGram(cleaned, 4).forEach(x => tokens.add(x));
    return Array.from(tokens);
}

function extractBoldTokens(text) {
    if (!text || typeof text !== 'string') return [];
    const tokens = [];
    const re = /\*\*([^*]+)\*\*/g;
    let m;
    while ((m = re.exec(text)) !== null) tokens.push(m[1].trim());
    return tokens.filter(Boolean);
}

class DedupIndex {
    buildFromLines(lines) {
        this.documents = new Map();
        this.invertedIndex = new Map();
        this.docFrequency = new Map();
        this.docLengths = new Map();
        this.boldDocTokens = new Map();
        this.entityDocMap = new Map();

        for (const line of lines) {
            const item = JSON.parse(line);
            if (item.type === 'entity') {
                const name = item.name;
                if (item.name) this._addDoc(item.name, name, 'name');
                if (item.definition) this._addDoc(item.definition, name, 'definition');
                if (item.definitionSource) this._addDoc(String(item.definitionSource), name, 'definitionSource');
            } else if (item.type === 'observation') {
                this.observations.set(item.id, item.content);
            }
        }
        // Second pass: link observations to entities
        for (const line of lines) {
            const item = JSON.parse(line);
            if (item.type === 'entity') {
                (item.observationIds || []).forEach(oid => {
                    const content = this.observations.get(oid);
                    if (content) this._addDoc(content, item.name, 'observation', oid);
                });
            }
        }

        this.invertedIndex.forEach((dm, token) => this.docFrequency.set(token, dm.size));
        this.totalDocs = this.documents.size;
        this._calcLengths();
    }

    constructor() {
        this.documents = new Map();
        this.invertedIndex = new Map();
        this.docFrequency = new Map();
        this.docLengths = new Map();
        this.boldDocTokens = new Map();
        this.entityDocMap = new Map();
        this.observations = new Map();
        this.totalDocs = 0;
        this.avgDocLength = 1;
    }

    _addDoc(content, entityName, field, observationId = null) {
        const docId = field === 'observation' ? `obs:${observationId}` : `entity:${entityName}:${field}`;
        const bold = extractBoldTokens(content);
        const clean = content.replace(/\*\*[^*]+\*\*/g, '');
        const tokens = new Set([...tokenizeForIndex(clean), ...bold]);
        if (bold.length > 0) this.boldDocTokens.set(docId, new Set(bold));
        this.documents.set(docId, { entityName, field, content, tokens });
        tokens.forEach(token => {
            if (!this.invertedIndex.has(token)) this.invertedIndex.set(token, new Map());
            this.invertedIndex.get(token).set(docId, (this.invertedIndex.get(token).get(docId) || 0) + 1);
        });
        // Track entity field docs (not observations) for entity comparison
        if (observationId === null) {
            if (!this.entityDocMap.has(entityName)) this.entityDocMap.set(entityName, []);
            this.entityDocMap.get(entityName).push(docId);
        }
    }

    _calcLengths() {
        let total = 0;
        this.documents.forEach((doc, docId) => {
            const len = doc.tokens.size;
            this.docLengths.set(docId, len);
            total += len;
        });
        this.avgDocLength = this.totalDocs > 0 ? total / this.totalDocs : 1;
    }

    _bm25(token, docId) {
        const doc = this.documents.get(docId);
        if (!doc || !doc.tokens.has(token)) return 0;
        const df = this.docFrequency.get(token) || 1;
        const idf = Math.log((this.totalDocs - df + 0.5) / (df + 0.5));
        const dl = this.docLengths.get(docId) || 1;
        const numerator = 1 * (BM25_K1 + 1);
        const denominator = 1 + BM25_K1 * (1 - BM25_B + (BM25_B * dl / this.avgDocLength));
        const boost = this.boldDocTokens.get(docId)?.has(token) ? 1.5 : 1.0;
        return idf * (numerator / denominator) * boost;
    }

    computeDocSimilarity(docIdA, docIdB) {
        const docA = this.documents.get(docIdA);
        const docB = this.documents.get(docIdB);
        if (!docA || !docB) return 0;
        const ta = Array.from(docA.tokens);
        const tb = Array.from(docB.tokens);
        if (ta.length === 0 || tb.length === 0) return 0;
        const ab = ta.reduce((s, t) => s + this._bm25(t, docIdB), 0) / ta.length;
        const ba = tb.reduce((s, t) => s + this._bm25(t, docIdA), 0) / tb.length;
        return Math.max(ab, ba);
    }
}

// --- Main ---
async function main() {
    const { memoryFilePath, mode } = workerData;

    // Load and parse JSONL
    const raw = await fs.readFile(memoryFilePath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim() !== '');

    const idx = new DedupIndex();
    idx.buildFromLines(lines);

    if (mode === 'obs') {
        const { chunk, threshold, maxPairs, obsMap } = workerData;
        const seen = new Set();
        const pairs = [];

        for (const docIdA of chunk) {
            const docA = idx.documents.get(docIdA);
            if (!docA) continue;

            const sc = new Map();
            for (const token of docA.tokens) {
                const df = idx.docFrequency.get(token) || 0;
                if (df > 200) continue;
                const dm = idx.invertedIndex.get(token);
                if (dm) dm.forEach((_, did) => {
                    if (did !== docIdA && did.startsWith('obs:')) sc.set(did, (sc.get(did) || 0) + 1);
                });
            }

            const cands = Array.from(sc.entries())
                .filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 100);

            for (const [docIdB] of cands) {
                const pk = docIdA < docIdB ? `${docIdA}|${docIdB}` : `${docIdB}|${docIdA}`;
                if (seen.has(pk)) continue;
                seen.add(pk);
                const score = idx.computeDocSimilarity(docIdA, docIdB);
                if (score >= threshold) pairs.push({ docIdA, docIdB, score });
            }
        }

        pairs.sort((a, b) => b.score - a.score);
        const rawScores = pairs.map(p => p.score);
        const om = new Map(obsMap);
        const resolved = pairs.slice(0, maxPairs).map(p => ({
            observationA: { id: parseInt(p.docIdA.replace('obs:', ''), 10), content: om.get(p.docIdA) || '' },
            observationB: { id: parseInt(p.docIdB.replace('obs:', ''), 10), content: om.get(p.docIdB) || '' },
            similarityScore: parseFloat(p.score.toFixed(4))
        }));
        parentPort.postMessage({ pairs: resolved, checked: seen.size, rawScores });
    } else if (mode === 'entity') {
        const { entityNames, start, end, threshold, maxPairs } = workerData;
        const pairs = [];
        let checked = 0;

        for (let i = start; i < end; i++) {
            const nameA = entityNames[i];
            const docsA = idx.entityDocMap.get(nameA) || [];
            for (let j = i + 1; j < entityNames.length; j++) {
                const nameB = entityNames[j];
                const docsB = idx.entityDocMap.get(nameB) || [];
                let bestScore = 0;
                let bestPair = null;
                for (const dA of docsA) {
                    for (const dB of docsB) {
                        checked++;
                        const score = idx.computeDocSimilarity(dA, dB);
                        if (score > bestScore) { bestScore = score; bestPair = { docA: dA, docB: dB }; }
                    }
                }
                if (bestScore >= threshold) {
                    pairs.push({
                        entityNameA: nameA, entityNameB: nameB,
                        score: bestScore, docA: bestPair.docA, docB: bestPair.docB
                    });
                }
            }
        }

        pairs.sort((a, b) => b.score - a.score);
        const rawScores = pairs.map(p => p.score);
        const top = pairs.slice(0, maxPairs).map(p => {
            const dA = idx.documents.get(p.docA);
            const dB = idx.documents.get(p.docB);
            return {
                entityA: { name: p.entityNameA, matchedField: dA?.field || 'name', matchedContent: dA?.content || '' },
                entityB: { name: p.entityNameB, matchedField: dB?.field || 'name', matchedContent: dB?.content || '' },
                similarityScore: parseFloat(p.score.toFixed(4))
            };
        });
        parentPort.postMessage({ pairs: top, checked, rawScores });
    }
}

main().catch(err => parentPort.postMessage({ error: err.message, pairs: [], checked: 0 }));
