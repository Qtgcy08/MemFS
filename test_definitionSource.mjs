// 测试 definitionSource 处理逻辑
const testEntities = [
  { name: 'Entity1', entityType: 'test', definition: 'Test 1' }, // 没有 definitionSource
  { name: 'Entity2', entityType: 'test', definition: 'Test 2', definitionSource: 'Source 2' }, // 有 definitionSource
  { name: 'Entity3', entityType: 'test', definition: 'Test 3', definitionSource: null } // definitionSource 为 null
];

// 测试转换逻辑
const cleanedEntities = testEntities.map(e => ({
  name: e.name,
  entityType: e.entityType,
  definition: e.definition || "",
  definitionSource: e.definitionSource === undefined ? null : e.definitionSource,
  observationIds: []
}));

console.log('Test entities:');
testEntities.forEach((e, i) => {
  console.log(`  Entity${i+1}:`, {
    name: e.name,
    hasDefinitionSource: 'definitionSource' in e,
    definitionSource: e.definitionSource,
    definitionSourceType: typeof e.definitionSource
  });
});

console.log('\nCleaned entities:');
cleanedEntities.forEach((e, i) => {
  console.log(`  Entity${i+1}:`, {
    name: e.name,
    definitionSource: e.definitionSource,
    definitionSourceType: typeof e.definitionSource
  });
});

// 测试 schema 验证
import { z } from 'zod';

const EntityOutputSchema = z.object({
    name: z.string(),
    entityType: z.string(),
    definition: z.string(),
    definitionSource: z.string().nullable(),
    observationIds: z.array(z.number())
});

console.log('\nSchema validation:');
cleanedEntities.forEach((e, i) => {
  try {
    const result = EntityOutputSchema.safeParse(e);
    console.log(`  Entity${i+1}:`, result.success ? '✅ Valid' : '❌ Invalid', result.error ? result.error.errors : '');
  } catch (err) {
    console.log(`  Entity${i+1}: Error`, err.message);
  }
});