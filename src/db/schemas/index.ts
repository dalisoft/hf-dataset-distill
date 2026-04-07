import type OpenAI from 'openai';
import { text, sqliteTable, index, blob } from 'drizzle-orm/sqlite-core';
export const storeTable = sqliteTable(
  'store',
  {
    batchId: text().primaryKey(),
    hash: text().unique().notNull()
  },
  (table) => [index('store_hash_idx').on(table.hash)]
);

export const outputBatchTable = sqliteTable(
  'output_batch',
  {
    request_id: text().primaryKey(),
    batch_id: text().unique().notNull(),
    status: text({
      enum: [
        'in_progress',
        'completed',
        'cancelling',
        'cancelled',
        'validating',
        'failed',
        'finalizing',
        'expired'
      ]
    })
      .notNull()
      .$type<OpenAI.Batches.Batch['status']>()
  },
  (table) => [index('output_batch_status_idx').on(table.status)]
);

export const datasetTable = sqliteTable('dataset', {
  batch_id: text().primaryKey(),
  messages: blob({ mode: 'json' }).$type<
    Array<
      | OpenAI.Responses.ResponseInputMessageItem
      | OpenAI.Responses.ResponseOutputMessage
    >
  >()
});
