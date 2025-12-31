import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { LLMFactory } from '../services/llmFactory';
import { AppConfig } from '../config/config';
import { HumanMessage, SystemMessage, BaseMessage } from '@langchain/core/messages';
import fs from 'fs-extra';
import path from 'path';
import { PlannerOutput } from './planner';

export class ExecutorAgent {
    private promptTemplate: string;
    private techStackPrompt: string;

    private config: AppConfig;
    private fastModel: BaseChatModel;
    private reasoningModel: BaseChatModel;

    constructor(config: AppConfig) {
        this.config = config;
        this.fastModel = LLMFactory.createLLM(config.models.executorFast);
        // Optimization: Lazy init or just init both. Init both is safer for now.
        this.reasoningModel = LLMFactory.createLLM(config.models.executorReasoning);

        const promptPath = path.join(process.cwd(), 'src', 'prompts', 'executor.txt');
        this.promptTemplate = fs.readFileSync(promptPath, 'utf-8');

        const techPath = path.join(process.cwd(), 'src', 'prompts', 'tech_stack.txt');
        this.techStackPrompt = fs.readFileSync(techPath, 'utf-8');
    }

    private getModel(plan: PlannerOutput): BaseChatModel {
        if (plan.target_model === 'reasoning') {
            console.log(`[EXECUTOR] Selected Model: REASONING (Reason: ${plan.target_model})`);
            return this.reasoningModel;
        }

        console.log(`[EXECUTOR] Selected Model: FAST (Reason: ${plan.target_model})`);
        return this.fastModel;
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

    public async execute(plan: PlannerOutput, contextMessages: BaseMessage[], queryId: string, logTimestamp: string): Promise<string> {
        const model = this.getModel(plan);
        const systemPrompt = this.buildSystemPrompt(plan);

        const messages = [
            new SystemMessage(systemPrompt),
            ...contextMessages
        ];

        console.log(`[EXECUTOR] Executing...`);
        const response = await model.invoke(messages, {
            metadata: {
                agent: "Executor",
                plan_model: plan.target_model,
                is_abuse: plan.is_abuse,
                is_self_reflection: plan.is_self_reflection,
                queryId: queryId,
                logTimestamp: logTimestamp
            }
        });
        return response.content as string;
    }
}
