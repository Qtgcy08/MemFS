import { KnowledgeGraphManager } from './index.js';
import { z } from 'zod';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const memoryPath = path.join(__dirname, 'memory', 'memory.jsonl');

async function test() {
  console.log('Testing listGraph with actual data from:', memoryPath);
  const manager = new KnowledgeGraphManager(memoryPath);
  
  try {
    const graph = await manager.listGraph();
    console.log('Graph loaded successfully');
    console.log('Entities count:', graph.entities.length);
    
    // 检查每个实体的 definitionSource
    graph.entities.forEach((entity, i) => {
      console.log(`Entity ${i}: ${entity.name}`);
      console.log(`  definitionSource: ${entity.definitionSource}`);
      console.log(`  definitionSource type: ${typeof entity.definitionSource}`);
      console.log(`  has definitionSource key: ${'definitionSource' in entity}`);
    });
    
    // 测试 schema 验证
    
    const EntityOutputSchema = z.object({
        name: z.string(),
        entityType: z.string(),
        definition: z.string(),
        definitionSource: z.string().nullable(),
        observationIds: z.array(z.number())
    });
    
    console.log('\nSchema validation for each entity:');
    graph.entities.forEach((entity, i) => {
      const result = EntityOutputSchema.safeParse(entity);
      if (result.success) {
        console.log(`  Entity ${i} (${entity.name}): ✅ Valid`);
      } else {
        console.log(`  Entity ${i} (${entity.name}): ❌ Invalid`);
        console.log(`    Errors:`, result.error.errors.map(e => `${e.path}: ${e.message}`));
      }
    });
    
    // 模拟 listGraph 工具的清理逻辑
    console.log('\nTesting listGraph tool cleaning logic:');
    const cleanGraph = {
        entities: graph.entities.map(e => ({
            name: e.name,
            entityType: e.entityType,
            definition: e.definition || "",
            definitionSource: e.definitionSource === undefined ? null : e.definitionSource,
            observationIds: e.observationIds || []
        })),
        observations: graph.observations.map(o => ({
            id: o.id,
            content: o.content,
            createdAt: o.createdAt || null
        })),
        relations: graph.relations.map(r => ({
            from: r.from,
            to: r.to,
            relationType: r.relationType
        }))
    };
    
    console.log('Cleaned entities validation:');
    cleanGraph.entities.forEach((entity, i) => {
      const result = EntityOutputSchema.safeParse(entity);
      if (result.success) {
        console.log(`  Entity ${i} (${entity.name}): ✅ Valid`);
      } else {
        console.log(`  Entity ${i} (${entity.name}): ❌ Invalid`);
        console.log(`    Errors:`, result.error.errors.map(e => `${e.path}: ${e.message}`));
      }
    });
    
  } catch (error) {
    console.error('Error:', error);
  }
}

test().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});