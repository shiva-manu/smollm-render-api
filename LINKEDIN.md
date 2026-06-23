**Self-Hosted LLM Inference on Render's Free Tier — What I Learned**

Most tutorials show you how to use managed inference APIs (OpenAI, Fireworks, Together AI, Groq, Replicate). I wanted to go the other direction: **can you serve a language model yourself on a free cloud tier?**

I deployed a quantized **SmolLM2-135M-Instruct** model (GGUF format) on **Render's free tier** using **Node.js, Express, and llama.cpp (node-llama-cpp)**. The result is a lightweight streaming inference API that runs entirely on free infrastructure.

**The Architecture**

The backend is a single ~400-line Express 5 server with:
- **Streaming text generation** — tokens are pushed character-by-character through a queue-based pump that respects backpressure (Node.js `drain` events). No buffering; the client sees output as it's generated.
- **Multi-turn conversations** — accepts an optional `messages` array and formats chat history as `Human:` / `Assistant:` pairs.
- **Concurrency control** — the model context supports only one sequence at a time. Concurrent requests get HTTP 429 ("model is busy"). This is a deliberate trade-off for simplicity, but a production system would queue or pool contexts.
- **Graceful degradation** — the model loads in the background. Requests land on 503 while loading, 500 if loading failed, and the server starts accepting health checks immediately.
- **Client disconnect handling** — if the user closes their browser mid-generation, an AbortController cancels the inference immediately.
- **Automatic context reset** — if the internal context window fills up, the server disposes and recreates it transparently.
- **Configurable via env vars** — max tokens, stream delay (for typewriter effect), generation timeout, context/batch/thread sizes, GPU acceleration toggle, and CORS origin.

**The Model**

SmolLM2-135M-Instruct quantized to Q4_K_M (~135M parameters, 4-bit). At ~80MB it fits comfortably on Render's free tier disk. The postinstall script downloads it automatically from Hugging Face.

**The Surprising Part**

It works. Not fast — you're getting ~10-20 tokens/sec on a free CPU instance — but the streaming makes it feel responsive. The typewriter effect from slow inference actually works *with* the UX rather than against it.

**Trade-offs I Observed**

| Factor | Self-Hosted (this project) | Managed Inference |
|--------|---------------------------|-------------------|
| Cost | Free tier eligible | Pay per token |
| Latency | CPU-bound, modest throughput | GPU-accelerated, fast |
| Control | Full stack visibility | Black box |
| Maintenance | You own it | They own it |
| Concurrency | Single sequence | Thousands of requests |
| Model flexibility | Any GGUF model | Provider's catalog |

**What I'd Do Differently**

- Add request queuing with a FIFO queue instead of returning 429
- Implement token-level metrics (prompt processing time, tokens/sec, time to first token)
- Add a WebSocket transport for bidirectional streaming
- Try larger models (the free tier has 512MB RAM — 135M params is comfortable, 1B+ might be tight)

**The Code**

The entire project is open source: `POST /chat` endpoint, `GET /health` status, streaming with backpressure, timeout protection, CORS, and deployment config for Render. The frontend is a separate Vite + TypeScript SPA.

The core lesson: **lightweight open-source models have reached a point where self-hosting on free cloud infrastructure is feasible.** Not for production-scale workloads, but for prototypes, demos, educational tools, and applications where you want full control over the inference stack without committing to a provider's ecosystem.
