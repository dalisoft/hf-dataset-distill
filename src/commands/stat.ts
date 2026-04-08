import Bun from 'bun';
import { encoding_for_model } from 'tiktoken';
import type OpenAI from 'openai';

const dataset_output_file = `dataset/gpt-5.4-xhigh-reasoning-700x.jsonl`;

const { format } = Intl.NumberFormat('en-US');

const file = Bun.file(dataset_output_file);
const dataset = await file.text();
const rows = Bun.JSONL.parse(
  dataset
) as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming[];

const row_messages = rows.map((row) => row.messages);

const input = row_messages
  .map((messages) =>
    messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
  )
  .join('');
const reasoning = row_messages
  .map((messages) =>
    messages
      .filter((message) => message.role === 'assistant')
      .map((message) =>
        message.content?.slice(
          0,
          message.content?.indexOf('</thinking>' as never)
        )
      )
  )
  .join('');
const output = row_messages
  .map((messages) =>
    messages
      .filter((message) => message.role === 'assistant')
      .map((message) =>
        message.content?.slice(
          message.content?.indexOf('</thinking>' as never) + 10
        )
      )
  )
  .join('');

const tokenizer = encoding_for_model('gpt-5');

const input_tokens = tokenizer.encode(input).length;
const reasoning_tokens = tokenizer.encode(reasoning).length;
const output_tokens = tokenizer.encode(output).length;

// Free-up memory
tokenizer.free();

// Calculate total tokens
const total_tokens = input_tokens + reasoning_tokens + output_tokens;

console.log(`Total tokens: ${format(total_tokens)}`);

console.log(`Input tokens: ${format(input_tokens)}`);
console.log(`Reasoning tokens: ${format(reasoning_tokens)}`);
console.log(`Output tokens: ${format(output_tokens)}`);
