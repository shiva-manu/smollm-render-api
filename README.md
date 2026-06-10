# SmolLM Render API

A Node.js Express API wrapping SmolLM (or other GGUF LLMs) using `node-llama-cpp`, featuring real-time plain-text response streaming.

## Features

- **Express Server:** Simple HTTP API endpoint for chat generation.
- **Node-Llama-CPP Integration:** Efficient local inference of GGUF format models.
- **Streaming:** Custom character-by-character streaming. Set `STREAM_CHUNK_DELAY_MS` if you want an artificial typewriter delay.
- **Connection Optimization:** Configured headers to prevent caching, proxy buffering (`no-transform`), and TCP socket delays (disables Nagle's algorithm).
- **Health Check:** `GET /health` reports model load state and whether generation is currently running.

## Getting Started

### Prerequisites

- Node.js (v18+ recommended)
- A GGUF model file (e.g., `model.gguf`) placed inside the `./models/` directory.

### Installation

1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Place your GGUF model in the `models` folder:
   ```bash
   mkdir -p models
   # Copy or download your model.gguf here
   ```

### Running the Server

Start the API server:
```bash
npm start
```
The server will run on `http://localhost:3000` by default.

### API Usage

#### POST `/chat`

Generate a streaming response for a given prompt.

**Request Body:**
```json
{
  "prompt": "Tell me a short joke",
  "maxTokens": 256
}
```

**Example Curl:**
```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Why is the sky blue?"}'
```

**Response:**
A stream of character-by-character plain text.

#### GET `/health`

Check whether the model is ready:
```bash
curl http://localhost:3000/health
```

### Environment

- `MODEL_PATH`: GGUF model path. Defaults to `./models/model.gguf`.
- `MAX_TOKENS`: Default token limit for requests that omit `maxTokens`. Defaults to `256`.
- `STREAM_CHUNK_DELAY_MS`: Artificial delay between streamed characters. Defaults to `0`.
- `GENERATION_TIMEOUT_MS`: Abort slow generations. Defaults to `120000`.
- `MODEL_CONTEXT_SIZE`, `MODEL_BATCH_SIZE`, `MODEL_THREADS`: Optional `node-llama-cpp` tuning knobs.
- `LLAMA_GPU`: Use `auto` to let `node-llama-cpp` probe GPU backends. Defaults to CPU-only.
