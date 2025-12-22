import { Message } from 'whatsapp-web.js';
import { AppConfig } from '../config/config';

// Constants for hardcoded values that aren't yet in config but should be consistent
const TRANSCRIBE_PREFIXES = ["@transcribe", "@t"];

/**
 * Gets a robust sender name from a WhatsApp message.
 * Prioritizes Contact Name > Pushname > Phone Number.
 */
export async function getSenderName(msg: Message): Promise<string> {
    try {
        const contact = await msg.getContact();
        return contact.name || contact.pushname || msg.from;
    } catch (e) {
        return msg.from;
    }
}

/**
 * Cleans a message body by removing triggers and loop prevention emojis.
 */
export function cleanMessageBody(body: string, config: AppConfig): string {
    const ignoreEmoji = config.bot.ignoreLoopEmoji;
    let cleanBody = body;

    // 1. Remove Loop Emoji
    if (ignoreEmoji) {
        // Create dynamic regex to remove all instances of the emoji
        const emojiRegex = new RegExp(ignoreEmoji, 'g');
        cleanBody = cleanBody.replace(emojiRegex, '');
    }

    // 2. Remove Triggers
    const triggers = config.bot.triggers;
    const allTriggers = [...triggers, ...TRANSCRIBE_PREFIXES];
    const triggerRegex = new RegExp(allTriggers.join('|'), 'gi');

    cleanBody = cleanBody.replace(triggerRegex, '').trim();

    return cleanBody;
}

/**
 * Checks if a message contains the loop prevention emoji.
 */
export function isLoopMessage(body: string, config: AppConfig): boolean {
    return body.includes(config.bot.ignoreLoopEmoji);
}

/**
 * Checks if a message is a trigger command.
 */
export function isTriggeredMessage(body: string, config: AppConfig): boolean {
    const triggers = config.bot.triggers;
    const bodyLower = body.toLowerCase();

    return triggers.some(t => bodyLower.includes(t.toLowerCase()))
        || TRANSCRIBE_PREFIXES.some(t => body.startsWith(t));
}

/**
 * Helper to identify explicit transcription requests.
 */
export function isExplicitTranscription(body: string): boolean {
    return TRANSCRIBE_PREFIXES.some(t => body.startsWith(t));
}
