import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { LLMFactory } from '../services/llmFactory';
import { ModelConfig } from '../config/config';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import fs from 'fs-extra';
import path from 'path';

export interface PlannerOutput {
    target_model: "fast" | "reasoning";
    is_self_reflection: boolean;
    is_abuse: boolean;
    needs_image: boolean;
    needs_audio: boolean;
    has_reply: boolean;
    time_ranges: Array<{
        start: string | null;
        end: string | null;
    }>;
    reasoning: string;
}

export class PlannerAgent {
    private model: BaseChatModel;
    private systemPrompt: string;

    constructor(modelConfig: ModelConfig) {
        this.model = LLMFactory.createLLM(modelConfig);

        const promptPath = path.join(process.cwd(), 'src', 'prompts', 'planner.txt');
        this.systemPrompt = fs.readFileSync(promptPath, 'utf-8');
    }

    public async plan(userMessage: string, metadata: string, historyContext: string, queryId: string, logTimestamp: string): Promise<PlannerOutput> {
        console.log(`[PLANNER] Planning for: "${userMessage}"`);

        const response = await this.model.invoke([
            new SystemMessage(this.systemPrompt),
            new HumanMessage(`METADATA: ${metadata}\n\nIMMEDIATE HISTORY:\n${historyContext}\n\nUSER MESSAGE: ${userMessage}`)
        ], {
            metadata: {
                agent: "Planner",
                query: userMessage,
                full_metadata: metadata,
                queryId: queryId,
                logTimestamp: logTimestamp
            }
        });

        const rawContent = response.content as string;

        try {
            // Attempt to parse JSON. Grok might wrap in markdown blocks ```json ... ```
            const cleanJson = rawContent.replace(/```json/g, '').replace(/```/g, '').trim();
            const plan = JSON.parse(cleanJson);

            // Validate minimal fields (fallback defaults)
            return {
                target_model: plan.target_model || "fast",
                is_self_reflection: !!plan.is_self_reflection,
                is_abuse: !!plan.is_abuse,
                needs_image: !!plan.needs_image,
                needs_audio: !!plan.needs_audio,
                has_reply: !!plan.has_reply,
                time_ranges: Array.isArray(plan.time_ranges) ? plan.time_ranges : [],
                reasoning: plan.reasoning || "No reasoning provided"
            };
        } catch (e) {
            console.error(`[PLANNER] Failed to parse plan: ${rawContent}`, e);
            // Default Fallback
            return {
                target_model: "fast",
                is_self_reflection: false,
                is_abuse: false,
                needs_image: false,
                needs_audio: false,
                has_reply: false,
                time_ranges: [{ start: null, end: null }], // Default to recent history on error
                reasoning: "Fallback due to parse error"
            };
        }
    }
}
