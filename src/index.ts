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
async function getPlannerContext(message: Message, chat: Chat): Promise<string> {
    const k = 1;

    if (message.hasQuotedMsg) {
        const q = await message.getQuotedMessage();
        const qType = (q.type === 'ptt' || q.type === 'audio') ? " [Audio Message]" : "";
        const qSender = await utils.getSenderName(q);
        const qBody = utils.cleanMessageBody(q.body, config);
        return `[Replying to ${qSender}]: ${qBody}${qType}`;
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
 * Gathers extended context based on the Plan (History search, downloading audio/images).
 */
async function gatherContext(
    message: Message,
    chat: Chat,
    plan: any,
    cleanBody: string,
    isExplicitTranscription: boolean
): Promise<BaseMessage[]> {
    const contextMessages: BaseMessage[] = [];
    let finalUserContent: any = `[CURRENT_QUERY] ${cleanBody}`;

    // 1. Current Message Media (Audio/PDF/Image)
    await handleCurrentMessageMedia(message, plan, cleanBody, isExplicitTranscription, contextMessages, (content) => finalUserContent = content);

    // 2. Historical Context (if needed)
    if (plan.context_needed) {
        await handleHistoricalContext(chat, plan, contextMessages);
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
    updateUserContent: (c: any) => void
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
            updateUserContent([
                { type: "text", text: cleanBody },
                { type: "image_url", image_url: { url: `data:${media.mimetype};base64,${media.data}` } }
            ]);
            console.log(`[CTX] Image attached. MIME: ${media.mimetype}, Size: ${media.data.length} chars.`);
        }
    }
}

async function handleHistoricalContext(chat: Chat, plan: any, contextMessages: BaseMessage[]) {
    const fetchLimit = 200;
    const recentMessages = await chat.fetchMessages({ limit: fetchLimit });

    // Determine Time Window
    let startTime = new Date(0);
    let endTime = new Date();

    if (plan.time_range && plan.time_range.start) {
        startTime = new Date(plan.time_range.start);
        if (plan.time_range.end) endTime = new Date(plan.time_range.end);
    } else {
        // "Last Active Day" Logic
        let lastMsgDate: Date | null = null;
        for (let i = recentMessages.length - 1; i >= 0; i--) {
            if (recentMessages[i].timestamp) {
                const d = new Date(recentMessages[i].timestamp * 1000);
                if (d.getTime() < Date.now() - 5000) {
                    lastMsgDate = d;
                    break;
                }
            }
        }
        if (lastMsgDate) {
            startTime = new Date(lastMsgDate);
            startTime.setHours(0, 0, 0, 0);
        } else {
            startTime = new Date();
            startTime.setHours(0, 0, 0, 0);
        }
    }

    console.log(`[CTX] Smart Window: ${startTime.toISOString()} - ${endTime.toISOString()}`);

    // Filter and Process Messages
    for (const msg of recentMessages) {
        const msgDate = new Date(msg.timestamp * 1000);
        if (msgDate >= startTime && msgDate <= endTime) {
            await processHistoryMessage(msg, msgDate, contextMessages);
        }
    }
}

async function processHistoryMessage(msg: Message, msgDate: Date, contextMessages: BaseMessage[]) {
    let additionalContent = "";
    const bodyClean = utils.cleanMessageBody(msg.body, config);
    const senderNameHistory = msg.fromMe ? config.bot.ownerName : await utils.getSenderName(msg);

    // Audio
    if (msg.hasMedia && (msg.type === 'audio' || msg.type === 'ptt')) {
        try {
            const media = await msg.downloadMedia();
            if (media) {
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
        const plannerContext = await getPlannerContext(message, chat);
        const senderName = await utils.getSenderName(message);
        const metadata = `Sender: ${senderName}, Timestamp: ${new Date().toISOString()}`;

        console.log("[PLANNER] Analyzing context...");
        const plan = await planner.plan(cleanBody, metadata, plannerContext);
        console.log(`[PLAN]`, JSON.stringify(plan, null, 2));

        // 6. GATHER CONTEXT
        const contextMessages = await gatherContext(message, chat, plan, cleanBody, isExplicitTranscription);

        // 7. EXECUTION
        const responseText = await executor.execute(plan, contextMessages);

        // 8. RESPONSE
        await message.reply(`${config.bot.ignoreLoopEmoji} ${responseText}`);

    } catch (error) {
        console.error("[ERROR] Processing failed:", error);
        await message.reply(`${config.bot.ignoreLoopEmoji}🐛 Error processing your request.`);
    }
});

console.log('Initializing WhatsApp Client...');
client.initialize();
