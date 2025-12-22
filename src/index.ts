import { Client, LocalAuth, Message } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import dotenv from 'dotenv';
import { ConfigLoader } from './config/config';
import { PlannerAgent } from './agents/planner';
import { ExecutorAgent } from './agents/executor';
import { RateLimiter } from './services/rateLimiter';
import { AudioService } from './services/audioService';
import { BaseMessage, HumanMessage, AIMessage } from '@langchain/core/messages';
import * as utils from './utils/messageUtils';

dotenv.config();

const config = ConfigLoader.load();

// Load rate limits from config
const rateLimiter = new RateLimiter(config.bot.rateLimit.maxRequests, config.bot.rateLimit.windowHours);
const audioService = new AudioService();
const planner = new PlannerAgent(config.models.planner);
const executor = new ExecutorAgent(config);

// --- WhatsApp Client ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox'],
    }
});

client.on('qr', (qr) => {
    console.log('QR RECEIVED', qr);
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Client is ready!');
});

client.on('message_create', async (message: Message) => {
    // 0. Loop Prevention (Moai Protocol)
    if (utils.isLoopMessage(message.body, config)) {
        console.log(`[IGNORE] Message contains ${config.bot.ignoreLoopEmoji} (Loop Prevention)`);
        return;
    }

    const chat = await message.getChat();

    // 1. Triggers & Commands
    const isTriggered = utils.isTriggeredMessage(message.body, config);

    // Help Command
    if (message.body.toLowerCase() === "@g help" || message.body.toLowerCase() === "@golem help") {
        await message.reply(`${config.bot.ignoreLoopEmoji} *Golem Bot *\n\nI am now smarter!\n- I plan before I speak.\n- I can see images and hear audio.\n- I can filter history by 'last week', '3 days', etc.\n\nTry replying to an audio note with '@g listen'!`);
        return;
    }

    if (!isTriggered) {
        return;
    }

    // 2. Rate Limiting
    if (!message.fromMe) {
        if (!rateLimiter.canRequest(message.from)) {
            console.warn(`[RATE LIMIT] Blocked ${message.from}`);
            await message.reply("🛑 Rate limit exceeded (10 requests/hour). Try again later.");
            return;
        }
    }

    console.log('\n\n');
    console.log(`[START] Processing request from ${message.from}`);

    const isExplicitTranscription = utils.isExplicitTranscription(message.body);
    if (isExplicitTranscription) {
        console.log(`[TRIGGER] Explicit transcription request detected`);
    }

    try {
        // 3. Clean Input
        let cleanBody = utils.cleanMessageBody(message.body, config);
        if (isExplicitTranscription && cleanBody.length === 0) {
            cleanBody = "Transcribe this audio";
        }

        // 4. PLANNER STEP
        // Fetch Immediate Context (Quoted msg OR last k messages)
        let plannerContext = "";
        const k = 1;

        if (message.hasQuotedMsg) {
            const q = await message.getQuotedMessage();
            const qType = (q.type === 'ptt' || q.type === 'audio') ? " [Audio Message]" : "";
            const qSender = await utils.getSenderName(q);
            const qBody = utils.cleanMessageBody(q.body, config);
            plannerContext = `[Replying to ${qSender}]: ${qBody}${qType}`;
        } else {
            const recent = await chat.fetchMessages({ limit: k });
            plannerContext = (await Promise.all(recent.map(async m => {
                const mType = (m.type === 'ptt' || m.type === 'audio') ? " [Audio Message]" : "";
                const sender = m.fromMe ? config.bot.ownerName : await utils.getSenderName(m);
                const mBody = utils.cleanMessageBody(m.body, config);
                return `[${sender}]: ${mBody}${mType}`;
            }))).join('\n');
        }

        const senderName = await utils.getSenderName(message);
        const metadata = `Sender: ${senderName}, Timestamp: ${new Date().toISOString()}`;
        console.log("[PLANNER] Analyzing context...");
        const plan = await planner.plan(cleanBody, metadata, plannerContext);

        console.log(`[PLAN]`, JSON.stringify(plan, null, 2));

        // 5. GATHER CONTEXT
        const contextMessages: BaseMessage[] = [];
        let finalUserContent: any = `[CURRENT_QUERY] ${cleanBody}`;

        // 5a. Audio Handling
        let audioText = "";
        if (message.hasMedia || message.hasQuotedMsg) {
            let targetMsg = message;
            if (message.hasQuotedMsg) {
                targetMsg = await message.getQuotedMessage();
            }

            if (targetMsg.hasMedia) {
                if ((targetMsg.type === 'audio' || targetMsg.type === 'ptt')) {
                    if (plan.needs_audio || isExplicitTranscription || cleanBody.includes("transcribe") || cleanBody.includes("listen")) {
                        console.log(`[CTX] Downloading Audio from msg ${targetMsg.id._serialized}...`);
                        const media = await targetMsg.downloadMedia();
                        if (media) {
                            const buffer = Buffer.from(media.data, 'base64');
                            audioText = await audioService.transcribe(targetMsg.id._serialized, buffer);
                            contextMessages.push(new HumanMessage(`[AUDIO TRANSCRIPTION]: ${audioText}`));
                            console.log(`[CTX] Audio transcribed: "${audioText.substring(0, 100)}${audioText.length > 100 ? '...' : ''}"`);
                        }
                    }
                } else if (targetMsg.type === 'document' && targetMsg.body.endsWith('.pdf')) {
                    console.log(`[CTX] Downloading PDF from msg ${targetMsg.id._serialized}...`);
                    const media = await targetMsg.downloadMedia();
                    if (media && media.mimetype === 'application/pdf') {
                        finalUserContent = [
                            { type: "text", text: cleanBody },
                            {
                                type: "image_url",
                                image_url: {
                                    url: `data:${media.mimetype};base64,${media.data}`
                                }
                            }
                        ];
                        console.log(`[CTX] PDF attached as multimodal content. Size: ${media.data.length} chars.`);
                    }
                }
            }
        }

        // 5b. History Handling (Smart Context & Multimodal)
        if (plan.context_needed) {
            let fetchLimit = 200;
            const recentMessages = await chat.fetchMessages({ limit: fetchLimit });

            // Determine Cutoff Date
            let startTime = new Date(0);
            let endTime = new Date();

            if (plan.time_range && plan.time_range.start) {
                startTime = new Date(plan.time_range.start);
                if (plan.time_range.end) endTime = new Date(plan.time_range.end);
            } else {
                // "Last Active Day" Logic
                let lastMsgDate: Date | null = null;
                for (let i = recentMessages.length - 1; i >= 0; i--) {
                    const m = recentMessages[i];
                    if (m.timestamp) {
                        const d = new Date(m.timestamp * 1000);
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

            // Filter and Process
            for (const msg of recentMessages) {
                const msgDate = new Date(msg.timestamp * 1000);
                if (msgDate >= startTime && msgDate <= endTime) {

                    let additionalContent = "";
                    const bodyClean = utils.cleanMessageBody(msg.body, config);
                    const senderNameHistory = msg.fromMe ? config.bot.ownerName : await utils.getSenderName(msg);

                    // Multimodal History
                    if (msg.hasMedia && (msg.type === 'audio' || msg.type === 'ptt')) {
                        try {
                            const media = await msg.downloadMedia();
                            if (media) {
                                const buffer = Buffer.from(media.data, 'base64');
                                const text = await audioService.transcribe(msg.id._serialized, buffer);
                                additionalContent += `\n[Audio Transcription]: ${text}`;
                            }
                        } catch (e) {
                            additionalContent += `\n[Audio Transcription Failed]`;
                        }
                    }

                    // Image Handling
                    let contentParts: any[] = [];
                    let hasRealImage = false;

                    if (msg.hasMedia && msg.type === 'image') {
                        try {
                            const media = await msg.downloadMedia();
                            if (media) {
                                hasRealImage = true;
                                contentParts.push({
                                    type: "text",
                                    text: `[${senderNameHistory}] (${msgDate.toISOString()}): [IMAGE SENT] ${bodyClean}${additionalContent}`
                                });
                                contentParts.push({
                                    type: "image_url",
                                    image_url: {
                                        url: `data:${media.mimetype};base64,${media.data}`
                                    }
                                });
                            }
                        } catch (e) {
                            additionalContent += `\n[Image Download Failed]`;
                        }
                    }

                    if (!hasRealImage) {
                        // Fallback
                        if (msg.hasMedia && msg.type === 'image') additionalContent += `\n[IMAGE OMITTED: Placeholder]`;

                        const formatted = `[${senderNameHistory}] (${msgDate.toISOString()}): ${bodyClean}${additionalContent}`;
                        if (msg.fromMe) {
                            contextMessages.push(new AIMessage(formatted));
                        } else {
                            contextMessages.push(new HumanMessage(formatted));
                        }
                    } else {
                        // Multimodal Message
                        if (msg.fromMe) {
                            contextMessages.push(new AIMessage({ content: contentParts }));
                        } else {
                            contextMessages.push(new HumanMessage({ content: contentParts }));
                        }
                    }
                }
            }
        }

        // 5c. Image Handling (Basic Current/Quoted)
        let imageMsg = message;
        if (message.hasQuotedMsg) imageMsg = await message.getQuotedMessage();

        if (imageMsg.hasMedia && (imageMsg.type === 'image') && plan.needs_image) {
            const media = await imageMsg.downloadMedia();
            if (media) {
                finalUserContent = [
                    { type: "text", text: cleanBody },
                    {
                        type: "image_url",
                        image_url: {
                            url: `data:${media.mimetype};base64,${media.data}`
                        }
                    }
                ];
                console.log(`[CTX] Image attached. MIME: ${media.mimetype}, Size: ${media.data.length} chars.`);
            }
        }

        contextMessages.push(new HumanMessage({ content: finalUserContent }));

        // 6. EXECUTE STEP
        const responseText = await executor.execute(plan, contextMessages);

        // 7. Reply
        await message.reply(`${config.bot.ignoreLoopEmoji} ${responseText}`);

    } catch (error) {
        console.error("[ERROR] Processing failed:", error);
        await message.reply(`${config.bot.ignoreLoopEmoji}🐛 Error processing your request.`);
    }
});

console.log('Initializing WhatsApp Client...');
client.initialize();
