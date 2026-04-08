import { db } from '../db.ts';
import { datasetTable } from '../db/schemas/index.ts';

const dataset_output_file = `dataset/gpt-5.4-xhigh-reasoning-550x.jsonl`;

const results = db
  .select({ messages: datasetTable.messages })
  .from(datasetTable)
  .all();

await Bun.file(dataset_output_file).write(
  results.map((result) => JSON.stringify(result)).join('\n')
);
