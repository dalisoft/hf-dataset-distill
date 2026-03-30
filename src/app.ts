import { JSONL, SHA256, file, randomUUIDv7 } from 'bun';
import { and, eq, not } from 'drizzle-orm';
import { setTimeout } from 'node:timers/promises';
import 'tss-env/auto.js';
import { db } from './db.ts';
import {
  datasetTable,
  outputBatchTable,
  storeTable
} from './db/schemas/index.ts';
import Anthropic from '@anthropic-ai/sdk';

const dataset_input_file = `dataset/programming-language-source-2000x.jsonl`;
const entries_limit = -1; // -1 for unlimited

const aisdk = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const distill_model = 'claude-opus-4-6';
const distill_max_output_tokens = 32000;

const jsonl_data_source = JSONL.parse(
  await file(dataset_input_file).text()
) as Array<{ messages: Anthropic.Messages.MessageParam[] }>;
const jsonl_data =
  typeof entries_limit === 'number' &&
  !Number.isNaN(entries_limit) &&
  entries_limit > -1
    ? jsonl_data_source.slice(0, entries_limit)
    : jsonl_data_source;

// Input file parsing
const input_messages = jsonl_data
  .map((data) => data.messages.slice(0, 1))
  .flat();

// Prepare dataset for batch
const messages_requests = input_messages.map((message) => ({
  custom_id: SHA256.hash(message.content.toString(), 'hex').toString(),
  params: {
    messages: [message]
  }
}));

// Create and write input batch file
const input_batch_content = JSON.stringify(messages_requests, null, 2);
// Total batch handling
const input_batch_hash = SHA256.hash(input_batch_content, 'hex').toString();

if (
  !db
    .select()
    .from(storeTable)
    .where(eq(storeTable.hash, input_batch_hash))
    .get()
) {
  await db.insert(storeTable).values({
    batchId: randomUUIDv7(),
    hash: input_batch_hash
  });
} else {
  console.log('Input file has not changed');
}

// Prepare batch and output
async function handleBatch(
  result: Anthropic.Messages.Batches.MessageBatchIndividualResponse
) {
  switch (result.result.type) {
    case 'succeeded':
      const user_messages =
        messages_requests.find((req) => req.custom_id === result.custom_id)
          ?.params?.messages ?? [];

      const messages: Anthropic.Messages.MessageParam[] = [
        ...user_messages,
        {
          role: 'assistant' as 'assistant',
          content: result.result.message.content
            .map((content) =>
              content.type === 'text'
                ? content.text
                : content.type === 'thinking'
                  ? `<${content.type}>${content.thinking}</${content.type}>`
                  : ''
            )
            .filter(Boolean)
            .join('\n') as Anthropic.Messages.MessageParam['content']
        }
      ].filter(Boolean);

      await db
        .insert(datasetTable)
        .values({
          batch_id: result.result.message.id,
          messages
        })
        .onConflictDoNothing();

      // Delete batch, CLEANUP
      /* await fetch(
          `https://api.anthropic.com/v1/messages/batches/${request.id}`,
          {
            method: 'DELETE',
            headers: anthropic_headers
          }
        ); */
      break;
    case 'canceled':
      console.log(`Request ${result.custom_id}: batch request canceled`);

      await db
        .delete(outputBatchTable)
        .where(eq(outputBatchTable.request_id, result.custom_id));

      break;
    case 'errored':
      if (result.result.error.error.type === 'invalid_request_error') {
        // Request body must be fixed before re-sending request
        console.log(`Validation error: ${result.custom_id}`);
      } else {
        // Request can be retried directly
        console.log(`Server error: ${result.custom_id}`);
      }
      break;
    case 'expired':
      console.log(`Request ${result.custom_id}: batch request expired`);

      await db
        .delete(outputBatchTable)
        .where(eq(outputBatchTable.request_id, result.custom_id));
      break;
  }
}

async function retrieveBatches(lastId: string | null) {
  const batches = await aisdk.messages.batches.list({
    limit: 500,
    ...(lastId !== null ? { after_id: lastId } : {})
  });
  const response = batches;

  if (!response.data) {
    console.log('Response failed', response);
    return;
  }
  const { data: batches_response, has_more, last_id } = response;

  await Promise.all(
    batches_response.map(async (request) => {
      if (
        db
          .select()
          .from(datasetTable)
          .where(and(eq(datasetTable.batch_id, request.id)))
          .get() ||
        db
          .select()
          .from(outputBatchTable)
          .where(
            and(
              eq(outputBatchTable.batch_id, request.id),
              eq(outputBatchTable.status, 'ended')
            )
          )
          .get()
      ) {
        // console.log('Batch entry end', request.id);

        for await (const batch_item of await aisdk.messages.batches.results(
          request.id
        )) {
          await handleBatch(batch_item);
        }

        return;
      }

      if (
        db
          .select()
          .from(outputBatchTable)
          .where(
            and(
              eq(outputBatchTable.batch_id, request.id),
              not(eq(outputBatchTable.status, request.processing_status))
            )
          )
          .get()
      ) {
        await db
          .update(outputBatchTable)
          .set({ status: request.processing_status })
          .where(eq(outputBatchTable.batch_id, request.id));
      }

      if (
        request.processing_status === 'ended' &&
        request.request_counts.succeeded
      ) {
        for await (const result of await aisdk.messages.batches.results(
          request.id
        )) {
          await handleBatch(result);
        }
      }
    })
  );

  if (has_more) {
    console.log('Has more items, paging to next page', { has_more, last_id });
    await setTimeout(1000 * 30);
    await retrieveBatches(last_id);
  }
}
await retrieveBatches(null);

// Initialize batch
for (const request of messages_requests) {
  if (
    db
      .select()
      .from(outputBatchTable)
      .where(eq(outputBatchTable.request_id, request.custom_id))
      .get()
  ) {
    continue;
  }

  const send_batch_response = await aisdk.messages.batches.create({
    requests: [
      {
        custom_id: request.custom_id,
        params: {
          ...request.params,
          model: distill_model,
          max_tokens: distill_max_output_tokens,
          service_tier: 'standard_only',
          output_config: { effort: 'max' },
          thinking: { type: 'adaptive' }
        }
      }
    ]
  });

  await db.insert(outputBatchTable).values({
    request_id: request.custom_id,
    batch_id: send_batch_response.id,
    status: send_batch_response.processing_status
  });

  console.log(
    `Request ${request.custom_id}: batch request sent ${send_batch_response.id}`
  );
}
