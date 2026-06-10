import express from "express";
import { getLlama, LlamaChatSession } from "node-llama-cpp";

try {
    process.loadEnvFile();
} catch {
    // Ignore if .env file is missing
}

const app=express();
app.use(express.json());

const configuredStreamDelayMs=Number(process.env.STREAM_CHUNK_DELAY_MS);
const STREAM_CHUNK_DELAY_MS=Number.isFinite(configuredStreamDelayMs)
    ? Math.max(0, configuredStreamDelayMs)
    : 10;

const configuredMaxTokens=Number(process.env.MAX_TOKENS);
const DEFAULT_MAX_TOKENS=Number.isFinite(configuredMaxTokens)
    ? Math.max(1, Math.floor(configuredMaxTokens))
    : 256;

const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
let generationInProgress=false;

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

async function initModel() {
    try {
        console.log("Loading model....");
        llama=await getLlama();
        model=await llama.loadModel({
            modelPath:"./models/model.gguf"
        });
        context=await model.createContext();
        modelLoaded=true;
        console.log("Model loaded successfully");
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
        if(context.sequencesLeft>0){
            return true;
        }
    }catch{
        // Fall through and rebuild the context below.
    }

    if(generationInProgress || contextResetInProgress){
        return false;
    }

    contextResetInProgress=true;

    try{
        await context.dispose();
        context=await model.createContext();
        return context.sequencesLeft>0;
    }finally{
        contextResetInProgress=false;
    }
}

app.post("/chat",async(req,res)=>{
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

    if(generationInProgress || !(await ensureContextSequenceAvailable())){
        return res.status(429).json({
            error:"model is busy, wait for the current response to finish"
        });
    }

    const promptMaxTokens=Number(maxTokens);
    const resolvedMaxTokens=Number.isFinite(promptMaxTokens)
        ? Math.max(1, Math.floor(promptMaxTokens))
        : DEFAULT_MAX_TOKENS;

    const abortController=new AbortController();
    const streamer=createSmoothWordStreamer(res);
    let responseFinished=false;
    let session;

    res.on("close",()=>{
        if(!responseFinished){
            streamer.close();
            abortController.abort(new Error("Client disconnected"));
        }
    });

    try{
        generationInProgress=true;

        session=new LlamaChatSession({
            contextSequence:context.getSequence(),
            autoDisposeSequence:true
        });

        res.setHeader("Content-Type","text/plain; charset=utf-8");
        res.setHeader("Cache-Control","no-cache, no-transform");
        res.setHeader("Connection","keep-alive");
        res.setHeader("Transfer-Encoding","chunked");
        res.setHeader("X-Content-Type-Options","nosniff");
        req.socket.setNoDelay(true);
        res.flushHeaders?.();

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

        await streamer.end();
        responseFinished=true;

        if(!res.destroyed && !res.writableEnded){
            res.end();
        }
    }catch(error){
        streamer.close();

        if(abortController.signal.aborted){
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
