import { JSONL, SHA256, file, randomUUIDv7 } from 'bun';
import { and, eq, not } from 'drizzle-orm';
import assert from 'node:assert';
import { createReadStream, createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import os from 'node:os';
import { setTimeout } from 'node:timers/promises';
import OpenAI from 'openai';
import 'tss-env/auto.js';
import { db } from './db.ts';
import {
  datasetTable,
  outputBatchTable,
  storeTable
} from './db/schemas/index.ts';

const dataset_input_file = `dataset/programming-language-source-2000x.jsonl`;
const entries_limit = -1; // -1 for unlimited

const aisdk = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const distill_model = 'gpt-5.4';
const distill_max_output_tokens = 32000;

const jsonl_data_source = JSONL.parse(
  await file(dataset_input_file).text()
) as Array<{
  messages: Array<
    | OpenAI.Responses.ResponseInputMessageItem
    | OpenAI.Responses.ResponseOutputMessage
  >;
}>;
const jsonl_data =
  typeof entries_limit === 'number' &&
  !Number.isNaN(entries_limit) &&
  entries_limit > -1
    ? jsonl_data_source.slice(0, entries_limit)
    : jsonl_data_source;

// Input file parsing
const input_messages = jsonl_data
  .map((data) => data?.messages?.slice(0, 1) ?? [])
  .flat();

// Prepare dataset for batch
const messages_requests = input_messages.map((message) => ({
  custom_id: SHA256.hash(message.toString(), 'hex').toString(),
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
async function handleBatch(result: OpenAI.Batches.Batch) {
  switch (result.status) {
    case 'completed':
      const content = await aisdk.files.content(result.input_file_id);
      const data = await content.json();

      const user_messages =
        messages_requests.find((req) => req.custom_id === data.custom_id)
          ?.params?.messages ?? [];

      const messages: Array<
        | OpenAI.Responses.ResponseInputMessageItem
        | OpenAI.Responses.ResponseOutputMessage
      > = [
        ...user_messages,
        {
          role: 'assistant',
          content: data.response.body.output
            .map((content: OpenAI.Responses.ResponseOutputItem) =>
              content.type === 'message'
                ? content.content
                    .map((c) => (c.type === 'output_text' ? c.text : ''))
                    .filter(Boolean)
                    .join('\n')
                : content.type === 'reasoning'
                  ? `<thinking>${
                      content.content
                        ?.map((c) =>
                          c.type === 'reasoning_text' ? c.text : ''
                        )
                        .filter(Boolean)
                        .join('\n') ?? ''
                    }</thinking>`
                  : ''
            )
            .filter(Boolean)
            .join('\n') as OpenAI.Responses.ResponseOutputText[]
        } satisfies OpenAI.Responses.ResponseOutputMessage
      ].filter(Boolean);

      await db
        .insert(datasetTable)
        .values({
          batch_id: result.id,
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
    case 'cancelled':
      console.log(`Request ${data.custom_id}: batch request canceled`);

      await db
        .delete(outputBatchTable)
        .where(eq(outputBatchTable.request_id, data.custom_id));

      break;
    case 'failed':
      console.log(`Server error: ${data.custom_id}`);
      break;
    case 'expired':
      console.log(`Request ${data.custom_id}: batch request expired`);

      await db
        .delete(outputBatchTable)
        .where(eq(outputBatchTable.request_id, data.custom_id));
      break;
  }
}

async function retrieveBatches(lastId: string | null) {
  const batches = await aisdk.batches.list({
    limit: 500,
    ...(lastId !== null ? { after: lastId } : {})
  });
  const response = batches;

  if (!response.data) {
    console.log('Response failed', response);
    return;
  }
  const { data: batches_response, has_more } = response;
  // @ts-expect-error It should work
  const last_id = response.nextPageRequestOptions()?.query?.id;
  assert.ok(last_id, 'Next query ID should be valid');

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
              eq(outputBatchTable.status, 'completed')
            )
          )
          .get()
      ) {
        // console.log('Batch entry end', request.id);

        const batch_item = await aisdk.batches.retrieve(request.id);
        await handleBatch(batch_item);

        return;
      }

      if (
        db
          .select()
          .from(outputBatchTable)
          .where(
            and(
              eq(outputBatchTable.batch_id, request.id),
              not(eq(outputBatchTable.status, request.status))
            )
          )
          .get()
      ) {
        await db
          .update(outputBatchTable)
          .set({ status: request.status })
          .where(eq(outputBatchTable.batch_id, request.id));
      }

      if (request.status === 'completed' && request.request_counts?.completed) {
        const result = await aisdk.batches.retrieve(request.id);
        await handleBatch(result);
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

  const tmpfile = `${os.tmpdir()}/${request.custom_id}.jsonl`;
  const file = createWriteStream(tmpfile);

  file.write(
    JSON.stringify({
      custom_id: request.custom_id,
      method: 'POST',
      url: '/v1/responses',
      body: {
        model: distill_model,
        input: request.params.messages,
        max_tokens: distill_max_output_tokens,
        reasoning: {
          effort: 'xhigh',
          summary: 'auto'
        }
      } as OpenAI.Responses.ResponseCreateParamsNonStreaming
    })
  );

  const upload_file = await aisdk.files.create({
    file: createReadStream(tmpfile),
    purpose: 'batch'
  });
  const send_batch_response = await aisdk.batches.create({
    input_file_id: upload_file.id,
    endpoint: '/v1/chat/completions',
    completion_window: '24h'
  });

  // Clean tmp file
  await unlink(tmpfile);

  await db.insert(outputBatchTable).values({
    request_id: request.custom_id,
    batch_id: send_batch_response.id,
    status: send_batch_response.status
  });

  console.log(
    `Request ${request.custom_id}: batch request sent ${send_batch_response.id}`
  );
}
