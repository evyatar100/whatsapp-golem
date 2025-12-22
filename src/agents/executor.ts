import { ChatXAI } from '@langchain/xai';
import { HumanMessage, SystemMessage, BaseMessage } from '@langchain/core/messages';
import fs from 'fs-extra';
import path from 'path';
import { PlannerOutput } from './planner';

export class ExecutorAgent {
    private promptTemplate: string;
    private techStackPrompt: string;

    constructor() {
        const promptPath = path.join(process.cwd(), 'src', 'prompts', 'executor.txt');
        this.promptTemplate = fs.readFileSync(promptPath, 'utf-8');

        const techPath = path.join(process.cwd(), 'src', 'prompts', 'tech_stack.txt');
        this.techStackPrompt = fs.readFileSync(techPath, 'utf-8');
    }

    private getModel(plan: PlannerOutput): ChatXAI {
        let modelId = process.env.GROK_MODEL_FAST;
        if (plan.target_model === 'reasoning') {
            modelId = process.env.GROK_MODEL_REASONING;
        }

        console.log(`[EXECUTOR] Selected Model: ${modelId} (Reason: ${plan.target_model})`);

        return new ChatXAI({
            apiKey: process.env.XAI_API_KEY,
            model: modelId || "grok-beta",
            temperature: 0.7,
        });
    }

    private buildSystemPrompt(plan: PlannerOutput): string {
        let fullPrompt = this.promptTemplate;

        // 1. Extract Personas
        const abuseMarker = "[ABUSE_PERSONA]";
        const standardMarker = "[STANDARD_PERSONA]";

        let persona = "";

        if (plan.is_abuse) {
            const parts = fullPrompt.split(abuseMarker);
            if (parts.length > 1) persona = parts[1].trim();
            else persona = "You are currently in abuse mode. Be snarky and dismissive.";
        } else {
            // Extract standard persona (between STANDARD and ABUSE)
            const afterStandard = fullPrompt.split(standardMarker)[1] || fullPrompt;
            const beforeAbuse = afterStandard.split(abuseMarker)[0];
            persona = beforeAbuse.trim();
        }

        // 2. Inject Self-Reflection Tech Stack
        if (plan.is_self_reflection) {
            persona += `\n\n${this.techStackPrompt}`;
        }

        return persona;
    }

    public async execute(plan: PlannerOutput, contextMessages: BaseMessage[]): Promise<string> {
        const model = this.getModel(plan);
        const systemPrompt = this.buildSystemPrompt(plan);

        const messages = [
            new SystemMessage(systemPrompt),
            ...contextMessages
        ];

        console.log(`[EXECUTOR] Executing...`);
        const response = await model.invoke(messages);
        return response.content as string;
    }
}
