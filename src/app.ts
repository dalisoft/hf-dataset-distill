import { JSONL, SHA256, file, randomUUIDv7 } from 'bun';
import { and, eq, not } from 'drizzle-orm';
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
const entries_limit = 1000; // -1 for unlimited

const aisdk = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 30 * 1000 * 60 /* 30 minutes */,
  maxRetries: 3
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
  result: OpenAI.Responses.Response,
  request: typeof outputBatchTable.$inferSelect
) {
  switch (result.status) {
    case 'completed':
      const user_messages =
        messages_requests.find((req) => req.custom_id === request.request_id)
          ?.params?.messages ?? [];

      const messages: Array<
        | OpenAI.Responses.ResponseInputMessageItem
        | Partial<OpenAI.Responses.ResponseOutputMessage>
      > = [
        ...user_messages,
        {
          role: 'assistant',
          content: result.output
            .map((content) =>
              content.type === 'message'
                ? content.content
                    .map((c) => (c.type === 'output_text' ? c.text : ''))
                    .filter(Boolean)
                    .join('\n')
                : content.type === 'reasoning'
                  ? `<thinking>${
                      content.summary
                        ?.map(
                          (c, i) => `<summary index="${i}">${c.text}</summary>`
                        )
                        .filter(Boolean)
                        .join('\n') ?? ''
                    }</thinking>`
                  : ''
            )
            .filter(Boolean)
            .join('\n') as unknown as OpenAI.Responses.ResponseOutputText[]
        } satisfies Partial<OpenAI.Responses.ResponseOutputMessage>
      ].filter(Boolean);

      await db
        .insert(datasetTable)
        .values({
          batch_id: result.id,
          messages
        })
        .onConflictDoNothing();

      break;
    case 'cancelled':
      console.log(`Request ${request.request_id}: batch request canceled`);

      await db
        .delete(outputBatchTable)
        .where(eq(outputBatchTable.request_id, request.request_id));

      break;
    case 'failed':
      console.log(`Server error: ${request.request_id}`, result.error?.message);

      await db
        .delete(outputBatchTable)
        .where(eq(outputBatchTable.request_id, request.request_id));

      break;
    case 'incomplete':
      console.log(`Request ${request.request_id}: batch request expired`);

      await db
        .delete(outputBatchTable)
        .where(eq(outputBatchTable.request_id, request.request_id));

      break;
  }
}

async function retrieveBatches(page = 0) {
  const batches = db
    .select()
    .from(outputBatchTable)
    .limit(100)
    .offset(page * 100)
    .all();

  await Promise.all(
    batches.map(async (request) => {
      const result = await aisdk.responses.retrieve(request.batch_id);

      if (
        db
          .select()
          .from(datasetTable)
          .where(and(eq(datasetTable.batch_id, request.batch_id)))
          .get() ||
        request.status === 'completed'
      ) {
        await handleBatch(result, request);

        return;
      }

      if (
        db
          .select()
          .from(outputBatchTable)
          .where(
            and(
              eq(outputBatchTable.batch_id, request.batch_id),
              not(eq(outputBatchTable.status, result.status ?? 'queued'))
            )
          )
          .get()
      ) {
        await db
          .update(outputBatchTable)
          .set({ status: result.status })
          .where(eq(outputBatchTable.batch_id, request.batch_id));
      }

      await handleBatch(result, request);
    })
  );

  if ((await db.$count(outputBatchTable)) > (page + 1) * 100) {
    await setTimeout(1000 * 30);
    await retrieveBatches(page + 1);
  }
}
await retrieveBatches(0);

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

  const send_flex_response = await aisdk.responses.create({
    model: distill_model,
    input: request.params.messages,
    max_output_tokens: distill_max_output_tokens,
    reasoning: {
      effort: 'xhigh',
      summary: 'auto'
    },
    service_tier: 'flex',
    background: true
  });

  await db.insert(outputBatchTable).values({
    request_id: request.custom_id,
    batch_id: send_flex_response.id,
    status: send_flex_response.status ?? 'queued'
  });

  console.log(
    `Request ${request.custom_id}: flex request sent ${send_flex_response.id}`
  );
}
