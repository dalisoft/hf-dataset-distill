# hf-dataset-distill

An project to help with distillation of models to get dataset with Batch API (50% discount)

- [GitHub](https://github.com/dalisoft/hf-dataset-distill)
- [HuggingFace](https://huggingface.co/datasets/dalisoft/claude-opus-4.6-high-reasoning-700x)

## Features

- Easy to use commands
- JS/TS Stack
- Hugging Face compatible

## Prerequisites

- Bun installed
- AI Provider API Key
- A money in AI Provider balance
- [Source dataset](./dataset/programming-language-source-2000x.jsonl)

## Commands

### Installation

```bash
bun install
```

### Running

Development:

```bash
bun run dev
```

Production:

```bash
bun run start
```

### Build dataset

```bash
bun run export
```

An file should be ready at [`dataset/`](./dataset/claude-opus-4.6-high-reasoning-700x.jsonl)

## License

Apache-2.0
