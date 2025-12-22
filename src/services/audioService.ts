import fs from 'fs-extra';
import path from 'path';
import OpenAI from 'openai';

export class AudioService {
    private cachePath: string;
    private cache: Record<string, string>;
    private openai: OpenAI;

    constructor() {
        this.cachePath = path.join(process.cwd(), '.cache', 'transcriptions.json');
        this.cache = {}; // Initialize empty, load async in init method could be better, but sync load is fine for startup
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });
        this.loadCache();
    }

    private loadCache() {
        try {
            if (fs.existsSync(this.cachePath)) {
                this.cache = fs.readJSONSync(this.cachePath);
            }
        } catch (e) {
            console.error("Failed to load audio cache", e);
            this.cache = {};
        }
    }

    private saveCache() {
        try {
            fs.writeJSONSync(this.cachePath, this.cache, { spaces: 2 });
        } catch (e) {
            console.error("Failed to save audio cache", e);
        }
    }

    public async transcribe(mediaId: string, audioBuffer: Buffer): Promise<string> {
        // 1. Check Cache
        if (this.cache[mediaId]) {
            console.log(`[AUDIO] Cache Hit for ${mediaId}`);
            return this.cache[mediaId];
        }

        console.log(`[AUDIO] Transcribing ${mediaId}...`);

        try {
            // OpenAI requires a File-like object. We can write to tmp or use specific buffer handling.
            // Simplest way for Node: write to temp file
            const tempDir = path.join(process.cwd(), '.cache', 'temp');
            await fs.ensureDir(tempDir);
            const tempFilePath = path.join(tempDir, `${mediaId}.mp3`); // Assuming generic extension, ffmpeg usually handles it or we detect mime

            await fs.writeFile(tempFilePath, audioBuffer);

            const fileStream = fs.createReadStream(tempFilePath);

            const response = await this.openai.audio.transcriptions.create({
                file: fileStream,
                model: "whisper-1",
            });

            const text = response.text;

            // Update Cache
            this.cache[mediaId] = text;
            this.saveCache();

            // Cleanup
            fs.unlink(tempFilePath).catch(() => { });

            return text;

        } catch (error) {
            console.error("[AUDIO] Transcription failed", error);
            throw error;
        }
    }
}
