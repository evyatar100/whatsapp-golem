import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatXAI } from '@langchain/xai';
import { ChatOpenAI } from '@langchain/openai';
import { ModelConfig } from '../config/config';
import { FileLoggingCallbackHandler } from './loggingCallbackHandler';

export class LLMFactory {
    public static createLLM(config: ModelConfig): BaseChatModel {
        const apiKey = process.env[config.apiKeyEnvVar];
        if (!apiKey) {
            console.warn(`[LLMFactory] Missing API key for env var: ${config.apiKeyEnvVar}. Model instantiation may fail.`);
        }

        switch (config.provider) {
            case 'grok':
                return new ChatXAI({
                    apiKey: apiKey,
                    model: config.modelName,
                    temperature: config.temperature ?? 0.7,
                    callbacks: [new FileLoggingCallbackHandler()]
                });
            case 'openai':
                return new ChatOpenAI({
                    apiKey: apiKey,
                    modelName: config.modelName,
                    temperature: config.temperature ?? 0.7,
                    callbacks: [new FileLoggingCallbackHandler()]
                });
            // Add other providers here (Anthropic, etc.)
            default:
                throw new Error(`Unsupported LLM provider: ${config.provider}`);
        }
    }
}
