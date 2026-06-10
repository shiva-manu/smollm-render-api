import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { finished } from "stream/promises";

const MODEL_DIR = "./models";
const MODEL_PATH = path.join(MODEL_DIR, "model.gguf");
const MODEL_URL = process.env.MODEL_URL || "https://huggingface.co/second-state/SmolLM-135M-Instruct-GGUF/resolve/main/SmolLM-135M-Instruct-Q4_K_M.gguf";

async function downloadModel() {
    if (fs.existsSync(MODEL_PATH)) {
        console.log("Model already exists locally, skipping download.");
        return;
    }

    console.log(`Model file not found. Downloading from ${MODEL_URL}...`);
    if (!fs.existsSync(MODEL_DIR)) {
        fs.mkdirSync(MODEL_DIR, { recursive: true });
    }

    const res = await fetch(MODEL_URL);
    if (!res.ok) {
        throw new Error(`Failed to download model: ${res.statusText} (${res.status})`);
    }

    const fileStream = fs.createWriteStream(MODEL_PATH);
    
    // Node.js v18+ supports Readable.fromWeb() for Web Streams returned by fetch
    await finished(Readable.fromWeb(res.body).pipe(fileStream));
    console.log("Model downloaded successfully and saved to " + MODEL_PATH);
}

downloadModel().catch((err) => {
    console.error("Error downloading model:", err);
    process.exit(1);
});
