import { db } from '../db.ts';
import { datasetTable } from '../db/schemas/index.ts';

const dataset_output_file = `dataset/claude-opus-4.6-high-reasoning-1700x.jsonl`;

const results = db
  .select({ messages: datasetTable.messages })
  .from(datasetTable)
  .all();
await Bun.file(dataset_output_file).write(
  results.map((result) => JSON.stringify(result)).join('\n')
);
