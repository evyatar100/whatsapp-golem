import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

export interface ModelConfig {
    provider: 'grok' | 'openai' | 'anthropic';
    modelName: string;
    apiKeyEnvVar: string;
    temperature?: number;
}

export interface AppConfig {
    bot: {
        triggers: string[];
        rateLimit: {
            maxRequests: number;
            windowHours: number;
        };
        ignoreLoopEmoji: string;
    };
    models: {
        planner: ModelConfig;
        executorFast: ModelConfig;
        executorReasoning: ModelConfig;
    };
    features: {
        audioTranscription: boolean;
        imageAnalysis: boolean;
    };
}

const DEFAULT_CONFIG: AppConfig = {
    bot: {
        triggers: ["@golem", "@g"],
        rateLimit: {
            maxRequests: 10,
            windowHours: 1
        },
        ignoreLoopEmoji: "🗿"
    },
    models: {
        planner: {
            provider: 'grok',
            modelName: 'grok-4-1-fast-non-reasoning',
            apiKeyEnvVar: 'XAI_API_KEY',
            temperature: 0
        },
        executorFast: {
            provider: 'grok',
            modelName: 'grok-4-1-fast-non-reasoning',
            apiKeyEnvVar: 'XAI_API_KEY',
            temperature: 0.7
        },
        executorReasoning: {
            provider: 'grok',
            modelName: 'grok-4-fast-reasoning',
            apiKeyEnvVar: 'XAI_API_KEY', // Fallback, usually separate
            temperature: 0.7
        }
    },
    features: {
        audioTranscription: true,
        imageAnalysis: true
    }
};

export class ConfigLoader {
    private static instance: AppConfig;

    public static load(): AppConfig {
        if (this.instance) return this.instance;

        const configPath = path.join(process.cwd(), 'config.yaml');
        let fileConfig: any = {};

        if (fs.existsSync(configPath)) {
            try {
                const fileContents = fs.readFileSync(configPath, 'utf8');
                fileConfig = yaml.load(fileContents);
                console.log(`[CONFIG] Loaded configuration from ${configPath}`);
            } catch (e) {
                console.warn(`[CONFIG] Failed to parse config.yaml, using defaults. Error: ${e}`);
            }
        } else {
            console.log(`[CONFIG] No config.yaml found, using defaults.`);
        }

        // Deep merge is better, but for now simple spread is okay-ish if structure matches.
        // To be safe, let's manually constructing the final object to ensure types.

        this.instance = {
            bot: { ...DEFAULT_CONFIG.bot, ...fileConfig.bot },
            models: {
                planner: { ...DEFAULT_CONFIG.models.planner, ...fileConfig.models?.planner },
                executorFast: { ...DEFAULT_CONFIG.models.executorFast, ...fileConfig.models?.executorFast },
                executorReasoning: { ...DEFAULT_CONFIG.models.executorReasoning, ...fileConfig.models?.executorReasoning },
            },
            features: { ...DEFAULT_CONFIG.features, ...fileConfig.features }
        };

        return this.instance;
    }
}
