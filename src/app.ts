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

const dataset_input_file = `dataset/programming-language-source-2000x.jsonl`;
const entries_limit = -1; // -1 for unlimited

const anthropic_headers = {
  'anthropic-version': '2023-06-01',
  'content-type': 'application/json',
  'x-api-key': process.env.ANTHROPIC_API_KEY
};
const distill_model = 'claude-opus-4-6';
const distill_max_output_tokens = 32000;

const jsonl_data_source = JSONL.parse(
  await file(dataset_input_file).text()
) as Array<{ messages: IMessageEntry[] }>;
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
  custom_id: SHA256.hash(message.content, 'hex').toString(),
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

async function retrieveBatches(lastId?: string) {
  const batches = await fetch(
    `https://api.anthropic.com/v1/messages/batches?limit=500${lastId ? '&after_id=' + lastId : ''}`,
    {
      headers: anthropic_headers
    }
  );
  const response = (await batches.json()) as {
    data: IBatchResponse[];
    has_more: boolean;
    last_id: string;
  };

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

        const get_batch_result_fetch = await fetch(
          `https://api.anthropic.com/v1/messages/batches/${request.id}/results`,
          {
            headers: anthropic_headers
          }
        );
        if (!get_batch_result_fetch.ok) {
          console.log('Failed response?', await get_batch_result_fetch.json());
          return;
        }

        const get_batch_result_response =
          (await get_batch_result_fetch.json()) as {
            custom_id: string;
            result: {
              message: {
                role: 'assistant';
                content: Array<
                  | { type: 'text'; text: string }
                  | { type: 'thinking'; thinking: string; signature: string }
                >;
              };
            };
          };

        /* console.log(
          `Request ${get_batch_result_response.custom_id}: status is ${request.processing_status}`
        ); */

        const user_messages =
          messages_requests.find(
            (req) => req.custom_id === get_batch_result_response.custom_id
          )?.params?.messages ?? [];

        const messages = [
          ...user_messages,
          {
            role: 'assistant' as 'assistant',
            content: get_batch_result_response.result.message.content
              .map(
                (
                  content:
                    | { type: 'text'; text: string }
                    | { type: 'thinking'; thinking: string; signature: string }
                ) =>
                  content.type === 'text'
                    ? content.text
                    : `<${content.type}>${content.thinking}</${content.type}>`
              )
              .join('\n')
          }
        ].filter(Boolean);

        await db
          .update(datasetTable)
          .set({
            messages
          })
          .where(eq(datasetTable.batch_id, request.id));
        /* await fetch(
          `https://api.anthropic.com/v1/messages/batches/${request.id}`,
          {
            method: 'DELETE',
            headers: anthropic_headers
          }
        ); */
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
        const get_batch_result_fetch = await fetch(
          `https://api.anthropic.com/v1/messages/batches/${request.id}/results`,
          {
            headers: anthropic_headers
          }
        );
        if (!get_batch_result_fetch.ok) {
          console.log('Failed response?', await get_batch_result_fetch.json());
          return;
        }

        const get_batch_result_response =
          (await get_batch_result_fetch.json()) as {
            custom_id: string;
            result: {
              message: {
                role: 'assistant';
                content: Array<
                  | { type: 'text'; text: string }
                  | { type: 'thinking'; thinking: string; signature: string }
                >;
              };
            };
          };

        /* console.log(
          `Request ${get_batch_result_response.custom_id}: status is ${request.processing_status}`
        ); */

        const user_messages =
          messages_requests.find(
            (req) => req.custom_id === get_batch_result_response.custom_id
          )?.params?.messages ?? [];

        const messages = [
          ...user_messages,
          {
            role: 'assistant' as 'assistant',
            content: get_batch_result_response.result.message.content
              .map(
                (
                  content:
                    | { type: 'text'; text: string }
                    | { type: 'thinking'; thinking: string; signature: string }
                ) =>
                  content.type === 'text'
                    ? content.text
                    : `<${content.type}>${content.thinking}</${content.type}>`
              )
              .join('\n')
          }
        ].filter(Boolean);

        await db
          .insert(datasetTable)
          .values({
            batch_id: request.id,
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
      }
    })
  );

  if (has_more) {
    console.log('Has more items, paging to next page', { has_more, last_id });
    await setTimeout(1000 * 30);
    await retrieveBatches(last_id);
  }
}
await retrieveBatches();

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

  const send_batch_fetch = await fetch(
    'https://api.anthropic.com/v1/messages/batches',
    {
      method: 'POST',
      headers: anthropic_headers,
      body: JSON.stringify({
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
      })
    }
  );
  if (send_batch_fetch.ok) {
    const send_batch_response =
      (await send_batch_fetch.json()) as IBatchResponse;

    await db.insert(outputBatchTable).values({
      request_id: request.custom_id,
      batch_id: send_batch_response.id,
      status: send_batch_response.processing_status
    });

    console.log(
      `Request ${request.custom_id}: batch request sent ${send_batch_response.id}`
    );
  } else {
    console.log(
      `Request ${request.custom_id}: failed to batch`,
      await send_batch_fetch.json()
    );
  }
}
