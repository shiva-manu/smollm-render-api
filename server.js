import express from "express";
import { getLlama, LlamaChatSession } from "node-llama-cpp";

try {
    process.loadEnvFile();
} catch {
    // Ignore if .env file is missing
}

const app=express();
app.use(express.json());

const MODEL_PATH=process.env.MODEL_PATH ?? "./models/model.gguf";

const parsePositiveInteger=(value,fallback)=>{
    const parsed=Number(value);

    if(Number.isFinite(parsed) && parsed>0){
        return Math.floor(parsed);
    }

    return fallback;
};

const configuredStreamDelayMs=Number(process.env.STREAM_CHUNK_DELAY_MS);
const STREAM_CHUNK_DELAY_MS=Number.isFinite(configuredStreamDelayMs)
    ? Math.max(0, configuredStreamDelayMs)
    : 0;

const configuredMaxTokens=Number(process.env.MAX_TOKENS);
const DEFAULT_MAX_TOKENS=Number.isFinite(configuredMaxTokens)
    ? Math.max(1, Math.floor(configuredMaxTokens))
    : 256;

const GENERATION_TIMEOUT_MS=parsePositiveInteger(
    process.env.GENERATION_TIMEOUT_MS,
    120_000
);
const MODEL_CONTEXT_SIZE=parsePositiveInteger(process.env.MODEL_CONTEXT_SIZE,undefined);
const MODEL_BATCH_SIZE=parsePositiveInteger(process.env.MODEL_BATCH_SIZE,undefined);
const MODEL_THREADS=parsePositiveInteger(process.env.MODEL_THREADS,undefined);
const LLAMA_GPU=process.env.LLAMA_GPU === "auto"
    ? "auto"
    : false;

const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
let generationInProgress=false;
let requestCounter=0;

const elapsedMs=(startedAt)=>Date.now()-startedAt;

function logChatStep(requestId,startedAt,message){
    console.log(`[chat ${requestId}] ${message} (${elapsedMs(startedAt)}ms)`);
}

function createSmoothWordStreamer(res,delayMs=STREAM_CHUNK_DELAY_MS){
    let buffer="";
    let pumping=false;
    let closed=false;
    const queue=[];
    const idleResolvers=[];

    const resolveIdle=()=>{
        if(queue.length!==0 || pumping){
            return;
        }

        while(idleResolvers.length>0){
            const resolve=idleResolvers.shift();
            resolve();
        }
    };

    const waitForDrain=()=>new Promise((resolve)=>{
        const done=()=>{
            res.off("drain",done);
            res.off("close",done);
            res.off("error",done);
            resolve();
        };

        res.once("drain",done);
        res.once("close",done);
        res.once("error",done);
    });

    const takeReadyChunks=(flush=false)=>{
        if (buffer.length === 0) {
            return [];
        }
        const readyText = buffer;
        buffer = "";
        return Array.from(readyText);
    };

    const pump=async()=>{
        if(pumping || closed){
            return;
        }

        pumping=true;

        try{
            while(!closed && queue.length>0){
                if(res.destroyed || res.writableEnded){
                    closed=true;
                    queue.length=0;
                    buffer="";
                    return;
                }

                const chunk=queue.shift();

                if(!res.write(chunk)){
                    await waitForDrain();
                }

                if(delayMs>0){
                    await sleep(delayMs);
                }
            }
        }catch{
            closed=true;
            queue.length=0;
            buffer="";
        }finally{
            pumping=false;

            if(!closed && queue.length>0){
                void pump();
            }else{
                resolveIdle();
            }
        }
    };

    const enqueueReadyChunks=(flush=false)=>{
        const chunks=takeReadyChunks(flush);

        if(chunks.length===0){
            return;
        }

        queue.push(...chunks);
        void pump();
    };

    return {
        push(text){
            if(closed || text===""){
                return;
            }

            buffer+=text;
            enqueueReadyChunks();
        },

        async end(){
            if(closed){
                return;
            }

            enqueueReadyChunks(true);

            if(queue.length===0 && !pumping){
                return;
            }

            await new Promise((resolve)=>idleResolvers.push(resolve));
        },

        close(){
            closed=true;
            queue.length=0;
            buffer="";
            resolveIdle();
        }
    };
}

let llama=null;
let model=null;
let context=null;
let contextResetInProgress=false;
let modelLoaded=false;
let modelLoadingError=null;

function getContextOptions(){
    return {
        sequences:1,
        ...(MODEL_CONTEXT_SIZE ? {contextSize:MODEL_CONTEXT_SIZE} : {}),
        ...(MODEL_BATCH_SIZE ? {batchSize:MODEL_BATCH_SIZE} : {}),
        ...(MODEL_THREADS ? {threads:MODEL_THREADS} : {})
    };
}

async function createModelContext(){
    return model.createContext(getContextOptions());
}

async function initModel() {
    const startedAt=Date.now();

    try {
        console.log(`Loading model from ${MODEL_PATH}...`);
        llama=await getLlama({
            gpu:LLAMA_GPU,
            ...(MODEL_THREADS ? {maxThreads:MODEL_THREADS} : {})
        });
        model=await llama.loadModel({
            modelPath:MODEL_PATH
        });
        context=await createModelContext();
        modelLoaded=true;
        console.log(`Model loaded successfully in ${elapsedMs(startedAt)}ms`);
    } catch (error) {
        console.error("Failed to load model:", error);
        modelLoadingError=error;
    }
}

initModel();

async function ensureContextSequenceAvailable(){
    if (!modelLoaded) {
        return false;
    }
    try{
        if(context && context.sequencesLeft>0){
            return true;
        }
    }catch(err){
        console.log("sequencesLeft check failed, will reset context:", err.message);
    }

    if(generationInProgress || contextResetInProgress){
        return false;
    }

    contextResetInProgress=true;

    try{
        try { await context?.dispose(); } catch {}
        context=await createModelContext();
        return context.sequencesLeft>0;
    }catch(err){
        console.error("Failed to reset context:", err);
        return false;
    }finally{
        contextResetInProgress=false;
    }
}

function getServiceStatus(){
    return {
        status:modelLoaded ? "ready" : modelLoadingError ? "error" : "loading",
        modelLoaded,
        modelLoadingError:modelLoadingError?.message ?? null,
        generationInProgress,
        contextResetInProgress,
        defaults:{
            maxTokens:DEFAULT_MAX_TOKENS,
            streamChunkDelayMs:STREAM_CHUNK_DELAY_MS,
            generationTimeoutMs:GENERATION_TIMEOUT_MS
        }
    };
}

app.get("/status",(req,res)=>{
    res.json(getServiceStatus());
});

app.get("/health",(req,res)=>{
    res.json(getServiceStatus());
});

app.post("/chat",async(req,res)=>{
    const requestId=++requestCounter;
    const requestStartedAt=Date.now();
    const {prompt,maxTokens}=req.body ?? {};

    if(typeof prompt!=="string" || prompt.trim()===""){
        return res.status(400).json({
            error:"prompt is required"
        });
    }

    if (!modelLoaded) {
        if (modelLoadingError) {
            return res.status(500).json({
                error: `Model failed to load: ${modelLoadingError.message}`
            });
        }
        return res.status(503).json({
            error: "Model is still loading in the background, please try again in a few moments."
        });
    }

    const promptMaxTokens=Number(maxTokens);
    const resolvedMaxTokens=Number.isFinite(promptMaxTokens)
        ? Math.max(1, Math.floor(promptMaxTokens))
        : DEFAULT_MAX_TOKENS;

    const abortController=new AbortController();
    const streamer=createSmoothWordStreamer(res);
    let responseFinished=false;
    let requestClosed=false;
    let generationTimedOut=false;
    let session;
    let generationTimer;

    res.on("close",()=>{
        requestClosed=true;

        if(!responseFinished){
            streamer.close();
            abortController.abort(new Error("Client disconnected"));
        }
    });

    if(generationInProgress || !(await ensureContextSequenceAvailable())){
        return res.status(429).json({
            error:"model is busy, wait for the current response to finish"
        });
    }

    try{
        generationInProgress=true;
        logChatStep(
            requestId,
            requestStartedAt,
            `accepted promptChars=${prompt.length} maxTokens=${resolvedMaxTokens}`
        );

        res.setHeader("Content-Type","text/plain; charset=utf-8");
        res.setHeader("Cache-Control","no-cache, no-transform");
        res.setHeader("Connection","keep-alive");
        res.setHeader("X-Accel-Buffering","no");
        res.setHeader("X-Content-Type-Options","nosniff");
        req.socket.setNoDelay(true);
        res.flushHeaders?.();
        logChatStep(requestId,requestStartedAt,"response headers flushed");

        if(requestClosed){
            return;
        }

        session=new LlamaChatSession({
            contextSequence:context.getSequence(),
            autoDisposeSequence:true
        });
        logChatStep(requestId,requestStartedAt,"chat session created");

        generationTimer=setTimeout(()=>{
            generationTimedOut=true;
            abortController.abort(
                new Error(`Generation timed out after ${GENERATION_TIMEOUT_MS}ms`)
            );
        },GENERATION_TIMEOUT_MS);

        await session.prompt(
            prompt,
            {
                signal:abortController.signal,
                stopOnAbortSignal:true,
                maxTokens:resolvedMaxTokens,
                onTextChunk(text){
                    streamer.push(text);
                }
            }
        );
        logChatStep(requestId,requestStartedAt,"model generation finished");

        await streamer.end();
        responseFinished=true;
        logChatStep(requestId,requestStartedAt,"response stream finished");

        if(!res.destroyed && !res.writableEnded){
            res.end();
        }
    }catch(error){
        streamer.close();

        if(abortController.signal.aborted && !generationTimedOut){
            return;
        }

        console.error(error);

        if(res.headersSent){
            responseFinished=true;
            return res.end(`\n[error] ${error.message}`);
        }

        return res.status(500).json({
            error:error.message
        });
    }finally{
        clearTimeout(generationTimer);
        session?.dispose();
        generationInProgress=false;
    }
});

app.get("/",(req,res)=>{
    res.send("SmolLM API Running");
});

const PORT=process.env.PORT || 3000;

const server=app.listen(PORT,"0.0.0.0",(error)=>{
    if(error){
        console.error(`Failed to start server on ${PORT}:`,error.message);
        process.exitCode=1;
        return;
    }

    console.log(`Server running on ${PORT}`);
});
