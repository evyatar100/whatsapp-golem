import { Client, LocalAuth, Message, Chat } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import dotenv from 'dotenv';
import { ConfigLoader, AppConfig } from './config/config';
import { PlannerAgent } from './agents/planner';
import { ExecutorAgent } from './agents/executor';
import { RateLimiter } from './services/rateLimiter';
import { AudioService } from './services/audioService';
import { BaseMessage, HumanMessage, AIMessage } from '@langchain/core/messages';
import * as utils from './utils/messageUtils';
import { getLogTimestamp } from './utils/dateUtils';
import fs from 'fs';
import path from 'path';
import mime from 'mime-types';

dotenv.config();

const config: AppConfig = ConfigLoader.load();

// Load services
const rateLimiter = new RateLimiter(config.bot.rateLimit.maxRequests, config.bot.rateLimit.windowHours);
const audioService = new AudioService();
const planner = new PlannerAgent(config.models.planner);
const executor = new ExecutorAgent(config);

// --- High Level Flow Functions ---

/**
 * Checks if the message should be ignored due to Loop Prevention.
 */
function shouldIgnoreLoop(message: Message, config: AppConfig): boolean {
    if (utils.isLoopMessage(message.body, config)) {
        console.log(`[IGNORE] Message contains ${config.bot.ignoreLoopEmoji} (Loop Prevention)`);
        return true;
    }
    return false;
}

/**
 * Checks for triggers or Help command.
 * Returns true if processing should continue, false if ignored or handled (like Help).
 */
async function handleTriggersAndCommands(message: Message, config: AppConfig): Promise<boolean> {
    const isTriggered = utils.isTriggeredMessage(message.body, config);

    // Help Command
    if (message.body.toLowerCase() === "@g help" || message.body.toLowerCase() === "@golem help") {
        await message.reply(`${config.bot.ignoreLoopEmoji} *Golem Bot *\n\nI am now smarter!\n- I plan before I speak.\n- I can see images and hear audio.\n- I can filter history by 'last week', '3 days', etc.\n\nTry replying to an audio note with '@g listen'!`);
        return false; // Handled, stop processing
    }

    return isTriggered;
}

/**
 * Checks rate limits for the user.
 * Returns true if allowed, false if blocked.
 */
async function checkRateLimit(message: Message): Promise<boolean> {
    if (!message.fromMe) {
        if (!rateLimiter.canRequest(message.from)) {
            console.warn(`[RATE LIMIT] Blocked ${message.from}`);
            await message.reply("🛑 Rate limit exceeded (10 requests/hour). Try again later.");
            return false;
        }
    }
    return true;
}

/**
 * Fetches and formats the Planner Context (Immediate history/quote).
 */
async function getPlannerContext(message: Message, chat: Chat, waClient: Client): Promise<string> {
    const k = 1;

    if (message.hasQuotedMsg) {
        const q = await message.getQuotedMessage();
        const qType = (q.type === 'ptt' || q.type === 'audio') ? " [Audio Message]" : "";
        const qSender = await utils.getSenderName(q);
        const qBody = utils.cleanMessageBody(q.body, config);
        let qTime = "Unknown";

        // Strategy 1: Standard Property
        if (q.timestamp) {
            try {
                qTime = new Date(q.timestamp * 1000).toISOString();
            } catch (e) {
                console.error(`[ERROR] Invalid timestamp for quoted message: ${q.timestamp}`);
            }
        }

        if (qTime === "Unknown") {
            // @ts-ignore - _data is a private property
            const rawData = (message as any)._data;
            if (rawData) {
                const quotedData = rawData.quotedMsg || rawData.quotedStanza;
                if (quotedData && quotedData.t) {
                    const rawTs = quotedData.t;
                    qTime = new Date(rawTs * 1000).toISOString();
                    console.log(`[INFO] Recovered timestamp from raw _data.${rawData.quotedMsg ? 'quotedMsg' : 'quotedStanza'}: ${qTime}`);
                }
            }
        }

        // Strategy 3: Network Fetch by ID
        if (qTime === "Unknown") {
            try {
                console.warn(`[WARN] Timestamp missing. Attempting fetch by ID: ${q.id._serialized}`);
                const fullMsg = await waClient.getMessageById(q.id._serialized);

                if (fullMsg && fullMsg.timestamp) {
                    qTime = new Date(fullMsg.timestamp * 1000).toISOString();
                    console.log(`[INFO] Successfully fetched timestamp for quoted message via ID: ${qTime}`);
                } else {
                    // Strategy 4: Deep Search in History
                    console.warn(`[WARN] Fetched message by ID missing timestamp. Trying Deep Search...`);
                    const history = await chat.fetchMessages({ limit: 100 });
                    const originalMsg = history.find(m => m.id._serialized === q.id._serialized);

                    if (originalMsg && originalMsg.timestamp) {
                        qTime = new Date(originalMsg.timestamp * 1000).toISOString();
                        console.log(`[INFO] Found message in history. Recovered timestamp: ${qTime}`);
                    } else {
                        console.warn(`[WARN] Failed to recover timestamp even after Deep Search.`);
                    }
                }
            } catch (err) {
                console.error(`[ERROR] Failed to fetch quoted message by ID:`, err);
            }
        }

        return `[USER_REPLY_TO_MESSAGE] (Timestamp: ${qTime}): ${qBody}${qType}`;
    }

    // Default: Last k messages
    const recent = await chat.fetchMessages({ limit: k });
    return (await Promise.all(recent.map(async m => {
        const mType = (m.type === 'ptt' || m.type === 'audio') ? " [Audio Message]" : "";
        const sender = m.fromMe ? config.bot.ownerName : await utils.getSenderName(m);
        const mBody = utils.cleanMessageBody(m.body, config);
        return `[${sender}]: ${mBody}${mType}`;
    }))).join('\n');
}

/**
 * Helper to save media to the query log directory.
 */
function saveMediaToLog(queryId: string, msgId: string, mimetype: string, dataBase64: string, logTimestamp: string) {
    if (!queryId) return;
    try {
        const logRoot = path.join(process.cwd(), '.llm_logs');
        const timestampShort = logTimestamp;
        const queryDirName = `${timestampShort}-${queryId}`;
        const dir = path.join(logRoot, queryDirName);

        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const ext = mime.extension(mimetype) || 'bin';
        const filename = `${msgId.replace(/[^a-zA-Z0-9]/g, '_')}.${ext}`;
        const filePath = path.join(dir, filename);

        const buffer = Buffer.from(dataBase64, 'base64');
        fs.writeFileSync(filePath, buffer);
        console.log(`[LOG] Saved asset: ${filePath}`);
    } catch (e) {
        console.error(`[LOG] Failed to save asset for query ${queryId}:`, e);
    }
}

/**
 * Gathers extended context based on the Plan (History search, downloading audio/images).
 */
async function gatherContext(
    message: Message,
    chat: Chat,
    plan: any,
    cleanBody: string,
    isExplicitTranscription: boolean,
    queryId: string,
    logTimestamp: string
): Promise<BaseMessage[]> {
    const contextMessages: BaseMessage[] = [];
    let finalUserContent: any = `[CURRENT_QUERY] ${cleanBody}`;

    // 1. Current Message Media (Audio/PDF/Image)
    await handleCurrentMessageMedia(message, plan, cleanBody, isExplicitTranscription, contextMessages, (content) => finalUserContent = content, queryId, logTimestamp);

    // 2. Historical Context (if needed)
    // 2. Historical Context (Time Ranges)
    await handleHistoricalContext(chat, plan, contextMessages, queryId, logTimestamp);

    // 3. Quoted Message Text (Crucial validity check: it is a reply)
    // We add this AFTER history but BEFORE the current prompt to prioritize it.
    if (message.hasQuotedMsg) {
        const q = await message.getQuotedMessage();
        if (q.type === 'chat' || q.type === 'image' || q.type === 'video' || q.type === 'audio' || q.type === 'ptt') {
            const qSender = await utils.getSenderName(q);
            const qBody = utils.cleanMessageBody(q.body, config);

            // Stronger emphasis on the replied message
            const replyContext = `
IMPORTANT: CAREFULLY READ THIS.
The user is specifically REPLYING to the following message. 
This message is the MOST critical context. Ignorance of this message constitutes a failure.
[REPLIED_TO_MESSAGE]
From: ${qSender}
Content: "${qBody}"
[END_REPLIED_TO_MESSAGE]
`;
            contextMessages.push(new HumanMessage(replyContext));
            console.log(`[CTX] Added quoted message (High Priority): "${qBody.substring(0, 50)}..."`);
        }
    }

    // Add final user query block
    contextMessages.push(new HumanMessage({ content: finalUserContent }));
    return contextMessages;
}

async function handleCurrentMessageMedia(
    message: Message,
    plan: any,
    cleanBody: string,
    isExplicitTranscription: boolean,
    contextMessages: BaseMessage[],
    updateUserContent: (c: any) => void,
    queryId: string,
    logTimestamp: string
) {
    let targetMsg = message;
    if (message.hasQuotedMsg) {
        targetMsg = await message.getQuotedMessage();
    }

    if (!targetMsg.hasMedia) return;

    // Audio
    if ((targetMsg.type === 'audio' || targetMsg.type === 'ptt')) {
        if (plan.needs_audio || isExplicitTranscription || cleanBody.includes("transcribe") || cleanBody.includes("listen")) {
            console.log(`[CTX] Downloading Audio from msg ${targetMsg.id._serialized}...`);
            const media = await targetMsg.downloadMedia();
            if (media) {
                saveMediaToLog(queryId, targetMsg.id._serialized, media.mimetype, media.data, logTimestamp);
                const buffer = Buffer.from(media.data, 'base64');
                const audioText = await audioService.transcribe(targetMsg.id._serialized, buffer);
                contextMessages.push(new HumanMessage(`[AUDIO TRANSCRIPTION]: ${audioText}`));
                console.log(`[CTX] Audio transcribed: "${audioText.substring(0, 100)}${audioText.length > 100 ? '...' : ''}"`);
            }
        }
    }
    // PDF
    else if (targetMsg.type === 'document' && targetMsg.body.endsWith('.pdf')) {
        console.log(`[CTX] Downloading PDF from msg ${targetMsg.id._serialized}...`);
        const media = await targetMsg.downloadMedia();
        if (media && media.mimetype === 'application/pdf') {
            saveMediaToLog(queryId, targetMsg.id._serialized, media.mimetype, media.data, logTimestamp);
            updateUserContent([
                { type: "text", text: cleanBody },
                { type: "image_url", image_url: { url: `data:${media.mimetype};base64,${media.data}` } }
            ]);
            console.log(`[CTX] PDF attached as multimodal content. Size: ${media.data.length} chars.`);
        }
    }
    // Image (if Plan needs it)
    else if (targetMsg.type === 'image' && plan.needs_image) {
        console.log(`[CTX] Downloading Image...`);
        const media = await targetMsg.downloadMedia();
        if (media) {
            saveMediaToLog(queryId, targetMsg.id._serialized, media.mimetype, media.data, logTimestamp);
            updateUserContent([
                { type: "text", text: cleanBody },
                { type: "image_url", image_url: { url: `data:${media.mimetype};base64,${media.data}` } }
            ]);
            console.log(`[CTX] Image attached. MIME: ${media.mimetype}, Size: ${media.data.length} chars.`);
        }
    }
}

async function handleHistoricalContext(chat: Chat, plan: any, contextMessages: BaseMessage[], queryId: string, logTimestamp: string) {
    if (!plan.time_ranges || plan.time_ranges.length === 0) {
        console.log(`[CTX] No time ranges specified. Focused mode.`);
        return;
    }

    const fetchLimit = 300; // Increased limit for safer fetching
    const recentMessages = await chat.fetchMessages({ limit: fetchLimit });

    // Set to track added message IDs to avoid duplicates
    const addedMessageIds = new Set<string>();

    for (const range of plan.time_ranges) {
        if (!range.start) continue;

        let startTime = new Date(range.start);
        let endTime = range.end ? (range.end === 'now' ? new Date() : new Date(range.end)) : new Date();

        // Fallback for invalid dates (e.g. if LLM messes up relative usage despite prompt)
        if (isNaN(startTime.getTime())) {
            // Simple fallback: "24h ago" handling or just skip
            if (range.start.includes("ago")) {
                startTime = new Date(Date.now() - 24 * 60 * 60 * 1000); // hard fallback 24h
                console.log("[CTX] Fallback parsing for start time: 24h ago");
            } else {
                console.log(`[CTX] Invalid start time: ${range.start}. Skipping.`);
                continue;
            }
        }

        console.log(`[CTX] Fetching range: ${startTime.toISOString()} - ${endTime.toISOString()}`);

        for (const msg of recentMessages) {
            const msgDate = new Date(msg.timestamp * 1000);
            if (msgDate >= startTime && msgDate <= endTime) {
                if (!addedMessageIds.has(msg.id._serialized)) {
                    await processHistoryMessage(msg, msgDate, contextMessages, queryId, logTimestamp);
                    addedMessageIds.add(msg.id._serialized);
                }
            }
        }
    }
}

async function processHistoryMessage(msg: Message, msgDate: Date, contextMessages: BaseMessage[], queryId: string, logTimestamp: string) {
    let additionalContent = "";
    const bodyClean = utils.cleanMessageBody(msg.body, config);
    const senderNameHistory = msg.fromMe ? config.bot.ownerName : await utils.getSenderName(msg);

    // Audio
    if (msg.hasMedia && (msg.type === 'audio' || msg.type === 'ptt')) {
        try {
            const media = await msg.downloadMedia();
            if (media) {
                saveMediaToLog(queryId, msg.id._serialized, media.mimetype, media.data, logTimestamp);
                const buffer = Buffer.from(media.data, 'base64');
                const text = await audioService.transcribe(msg.id._serialized, buffer);
                additionalContent += `\n[Audio Transcription]: ${text}`;
            }
        } catch (e) { additionalContent += `\n[Audio Transcription Failed]`; }
    }

    // Image
    let contentParts: any[] = [];
    let hasRealImage = false;

    if (msg.hasMedia && msg.type === 'image') {
        try {
            const media = await msg.downloadMedia();
            if (media) {
                saveMediaToLog(queryId, msg.id._serialized, media.mimetype, media.data, logTimestamp);
                hasRealImage = true;
                contentParts = [
                    { type: "text", text: `[${senderNameHistory}] (${msgDate.toISOString()}): [IMAGE SENT] ${bodyClean}${additionalContent}` },
                    { type: "image_url", image_url: { url: `data:${media.mimetype};base64,${media.data}` } }
                ];
            }
        } catch (e) { additionalContent += `\n[Image Download Failed]`; }
    }

    if (!hasRealImage) {
        if (msg.hasMedia && msg.type === 'image') additionalContent += `\n[IMAGE OMITTED: Placeholder]`;
        const formatted = `[${senderNameHistory}] (${msgDate.toISOString()}): ${bodyClean}${additionalContent}`;
        contextMessages.push(msg.fromMe ? new AIMessage(formatted) : new HumanMessage(formatted));
    } else {
        contextMessages.push(msg.fromMe ? new AIMessage({ content: contentParts }) : new HumanMessage({ content: contentParts }));
    }
}


// --- Main Entry Point ---

// Create Client
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ['--no-sandbox'] }
});

client.on('qr', (qr) => {
    console.log('QR RECEIVED', qr);
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Client is ready!');
});

// Main Message Handler
client.on('message_create', async (message: Message) => {
    try {
        // 1. Loop Prevention
        if (shouldIgnoreLoop(message, config)) return;

        // 2. Triggers & Commands
        const shouldProcess = await handleTriggersAndCommands(message, config);
        if (!shouldProcess) return;

        // 3. Rate Limit
        const isAllowed = await checkRateLimit(message);
        if (!isAllowed) return;

        console.log('\n\n[START] Processing request from', message.from);
        const chat = await message.getChat();

        // 4. Input Preparation
        const isExplicitTranscription = utils.isExplicitTranscription(message.body);
        if (isExplicitTranscription) console.log(`[TRIGGER] Explicit transcription detected`);

        let cleanBody = utils.cleanMessageBody(message.body, config);
        if (isExplicitTranscription && cleanBody.length === 0) cleanBody = "Transcribe this audio";

        // 5. PLANNING
        const plannerContext = await getPlannerContext(message, chat, client);
        const senderName = await utils.getSenderName(message);
        const metadata = `Sender: ${senderName}, Timestamp: ${new Date().toISOString()}`;

        // Extact timestamp from message (it's in seconds, convert to ms)
        const messageDate = new Date(message.timestamp * 1000);
        const logTimestamp = getLogTimestamp(messageDate);

        // Generate Query ID
        const queryId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        console.log(`[START] Query ID: ${queryId}`);

        console.log("[PLANNER] Analyzing context...");
        const plan = await planner.plan(cleanBody, metadata, plannerContext, queryId, logTimestamp);
        console.log(`[PLAN]`, JSON.stringify(plan, null, 2));

        // 6. GATHER CONTEXT
        const contextMessages = await gatherContext(message, chat, plan, cleanBody, isExplicitTranscription, queryId, logTimestamp);

        // 7. EXECUTION
        const responseText = await executor.execute(plan, contextMessages, queryId, logTimestamp);

        // 8. RESPONSE
        await message.reply(`${config.bot.ignoreLoopEmoji} ${responseText}`);

    } catch (error) {
        console.error("[ERROR] Processing failed:", error);
        await message.reply(`${config.bot.ignoreLoopEmoji}🐛 Error processing your request.`);
    }
});

console.log('Initializing WhatsApp Client...');
client.initialize();
