import Bun from 'bun';
import { countTokens } from '@anthropic-ai/tokenizer';

const dataset_output_file = `dataset/claude-opus-4.6-high-reasoning-700x.jsonl`;

const { format } = Intl.NumberFormat('en-US');

const file = Bun.file(dataset_output_file);
const dataset = await file.text();
const rows = Bun.JSONL.parse(dataset) as unknown as IMessages[];

const row_messages = rows.map((row) => row.messages);

const input = row_messages
  .map((messages) =>
    messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
  )
  .join('');
const output = row_messages
  .map((messages) =>
    messages
      .filter((message) => message.role === 'assistant')
      .map((message) => message.content)
  )
  .join('');

const input_tokens = countTokens(input);
const output_tokens = countTokens(output);
const total_tokens = input_tokens + output_tokens;

console.log(`Total tokens: ${format(total_tokens)}`);

console.log(`Input tokens: ${format(input_tokens)}`);
console.log(`Output tokens: ${format(output_tokens)}`);
