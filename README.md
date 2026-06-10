# SmolLM Render API

A Node.js Express API wrapping SmolLM (or other GGUF LLMs) using `node-llama-cpp`, featuring real-time, ultra-smooth character-by-character response streaming.

## Features

- **Express Server:** Simple HTTP API endpoint for chat generation.
- **Node-Llama-CPP Integration:** Efficient local inference of GGUF format models.
- **Smooth Streaming:** Custom character-by-character streaming with a default 10ms delay for a fluid typewriter-like user experience.
- **Connection Optimization:** Configured headers to prevent caching, proxy buffering (`no-transform`), and TCP socket delays (disables Nagle's algorithm).

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
