import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { Serialized } from "@langchain/core/load/serializable";
import { LLMResult } from "@langchain/core/outputs";
import { ChatGeneration } from "@langchain/core/outputs";
import fs from 'fs-extra';
import path from 'path';
import { getLogTimestamp } from '../utils/dateUtils';

export class FileLoggingCallbackHandler extends BaseCallbackHandler {
    name = "FileLoggingCallbackHandler";
    private logDirectory: string;
    private currentLogEntry: any = {};

    constructor() {
        super();
        this.logDirectory = path.join(process.cwd(), '.llm_logs');
        // Ensure log directory exists
        if (!fs.existsSync(this.logDirectory)) {
            fs.mkdirSync(this.logDirectory, { recursive: true });
        }
    }

    async handleLLMStart(
        llm: Serialized,
        prompts: string[],
        runId: string,
        parentRunId?: string,
        extraParams?: any,
        tags?: string[],
        metadata?: any
    ): Promise<void> {
        this.currentLogEntry[runId] = {
            timestamp: new Date().toISOString(),
            runId: runId,
            modelName: llm.id[llm.id.length - 1], // Extract model name roughly
            inputs: prompts,
            metadata: metadata,
            tags: tags
        };
    }

    async handleChatModelStart(
        llm: Serialized,
        messages: any[][],
        runId: string,
        parentRunId?: string,
        extraParams?: any,
        tags?: string[],
        metadata?: any
    ): Promise<void> {
        this.currentLogEntry[runId] = {
            timestamp: new Date().toISOString(),
            runId: runId,
            modelName: llm.id[llm.id.length - 1],
            inputs: messages.map(m => m.map(msg => ({ type: msg.id ? msg.id[msg.id.length - 1] : msg.constructor.name, content: msg.content }))),
            metadata: metadata,
            tags: tags
        };
    }

    private writeLogToFile(entry: any, runId: string) {
        let entryDir = this.logDirectory;
        let filename = `${new Date().toISOString().replace(/[:.]/g, '-')}-${runId}.json`;

        if (entry.metadata && entry.metadata.queryId) {
            // Create a directory for this query
            // Example name: 251222-153045-queryid
            // Use provided logTimestamp if available (from metadata), otherwise fallback to current time
            const timestampShort = entry.metadata.logTimestamp || getLogTimestamp();
            const queryDirName = `${timestampShort}-${entry.metadata.queryId}`;
            entryDir = path.join(this.logDirectory, queryDirName);

            if (!fs.existsSync(entryDir)) {
                fs.mkdirSync(entryDir, { recursive: true });
            }

            // Filename can be simpler if we are in a dedicated dir
            // Use Agent name if available
            if (entry.metadata.agent) {
                filename = `${entry.metadata.agent}.json`;
            }
        }

        const filePath = path.join(entryDir, filename);
        const logContent = JSON.stringify(entry, null, 2);
        fs.writeFileSync(filePath, logContent);
    }

    async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
        if (this.currentLogEntry[runId]) {
            const entry = this.currentLogEntry[runId];
            entry.output = output.generations.map(gen => gen.map(g => {
                const text = g.text;
                // Safe cast or check for message property if it's a ChatGeneration
                const message = (g as ChatGeneration).message?.content;
                return message || text;
            }));
            entry.tokenUsage = output.llmOutput?.tokenUsage;
            entry.endTime = new Date().toISOString();

            this.writeLogToFile(entry, runId);

            // Clean up memory
            delete this.currentLogEntry[runId];
        }
    }

    async handleLLMError(err: any, runId: string): Promise<void> {
        if (this.currentLogEntry[runId]) {
            const entry = this.currentLogEntry[runId];
            entry.error = err.message;
            entry.endTime = new Date().toISOString();

            this.writeLogToFile(entry, runId);

            delete this.currentLogEntry[runId];
        }
    }
}
