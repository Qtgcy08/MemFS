/**
 * MemFS Visualizer Server
 * Express SPA + direct KnowledgeGraphManager access (no MCP protocol)
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createManagers } from '../../index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.VISUALIZER_PORT || 3000;

// In-memory manager instance
let manager = null;
let searchIntegrator = null;

async function initManager() {
    if (manager) return { manager, searchIntegrator };
    
    const memoryPath = process.env.MEMORY_DIR 
        ? path.join(process.env.MEMORY_DIR, 'memory.jsonl')
        : undefined;
    
    const result = await createManagers({ memoryPath });
    manager = result.knowledgeGraphManager;
    searchIntegrator = result.searchIntegrator;
    
    return { manager, searchIntegrator };
}

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API Routes

// GET /api/stats - Get knowledge graph statistics
app.get('/api/stats', async (req, res) => {
    try {
        const { manager } = await initManager();
        const graph = await manager.loadGraph();
        
        res.json({
            entityCount: graph.entities.length,
            observationCount: graph.observations.length,
            relationCount: graph.relations.length,
            entityTypes: countEntityTypes(graph.entities),
            lastUpdated: graph._lastModified || null
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

function countEntityTypes(entities) {
    const counts = {};
    entities.forEach(e => {
        const type = e.entityType || 'unknown';
        counts[type] = (counts[type] || 0) + 1;
    });
    return counts;
}

// GET /api/graph - Get full graph data for Sigma.js
app.get('/api/graph', async (req, res) => {
    try {
        const { manager } = await initManager();
        const graph = await manager.loadGraph();
        
        // Transform to Sigma.js format
        const nodes = graph.entities.map(e => ({
            id: e.name,
            label: e.name,
            entityType: e.entityType,
            definition: e.definition,
            size: Math.min(10, 3 + (e.observationIds?.length || 0) * 0.5)
        }));
        
        const edges = graph.relations.map(r => ({
            id: `${r.from}-${r.to}-${r.relationType}`,
            source: r.from,
            target: r.to,
            relationType: r.relationType,
            label: r.relationType
        }));
        
        res.json({ nodes, edges });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/entities - List all entities
app.get('/api/entities', async (req, res) => {
    try {
        const { manager } = await initManager();
        const nodes = await manager.listNode();
        res.json(nodes);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/entities/:name - Get single entity details
app.get('/api/entities/:name', async (req, res) => {
    try {
        const { manager } = await initManager();
        const data = await manager.readNode([req.params.name]);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/entities - Create entities
app.post('/api/entities', async (req, res) => {
    try {
        const { manager } = await initManager();
        const result = await manager.createEntity(req.body.entities);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// PUT /api/entities/:name - Update entity
app.put('/api/entities/:name', async (req, res) => {
    try {
        const { manager } = await initManager();
        const result = await manager.updateNode({
            updates: [{ entityName: req.params.name, ...req.body }]
        });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE /api/entities/:name - Delete entity
app.delete('/api/entities/:name', async (req, res) => {
    try {
        const { manager } = await initManager();
        const result = await manager.deleteEntity([req.params.name]);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/relations - Create relation
app.post('/api/relations', async (req, res) => {
    try {
        const { manager } = await initManager();
        const result = await manager.createRelation(req.body.relations);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE /api/relations - Delete relation
app.delete('/api/relations', async (req, res) => {
    try {
        const { manager } = await initManager();
        const result = await manager.deleteRelation(req.body.relations);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/observations - Add observation to entity
app.post('/api/observations', async (req, res) => {
    try {
        const { manager } = await initManager();
        const result = await manager.addObservation(req.body.observations);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/search - Search entities
app.get('/api/search', async (req, res) => {
    try {
        const { manager, searchIntegrator } = await initManager();
        const query = req.query.q || '';
        const limit = parseInt(req.query.limit) || 15;
        
        // Use searchIntegrator for hybrid search
        if (searchIntegrator && query) {
            await searchIntegrator.ensureIndex();
            const results = await searchIntegrator.hybridService.search(query, limit);
            res.json(results);
        } else {
            res.json({ entities: [], observations: [], relations: [] });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Serve React SPA for all other routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.error(`[Visualizer] MemFS Visualizer running on http://localhost:${PORT}`);
});
