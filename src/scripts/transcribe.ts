import dotenv from 'dotenv';
import { AudioService } from '../services/audioService';
import fs from 'fs-extra';
import path from 'path';

dotenv.config();

async function main() {
    const filePath = process.argv[2];

    if (!filePath) {
        console.error("Usage: ts-node src/scripts/transcribe.ts <file-path>");
        process.exit(1);
    }

    if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        process.exit(1);
    }

    const audioService = new AudioService();
    const mediaId = path.basename(filePath);
    
    console.log(`Reading file: ${filePath}`);
    const buffer = await fs.readFile(filePath);
    
    try {
        console.log("Starting transcription...");
        const transcription = await audioService.transcribe(mediaId, buffer);
        
        const outputFilePath = filePath.replace(path.extname(filePath), '.txt');
        await fs.writeFile(outputFilePath, transcription);
        
        console.log("\n--- Transcription saved to: " + outputFilePath + " ---\n");
        console.log(transcription);
        console.log("\n--- End of Transcription ---\n");
    } catch (error) {
        console.error("Transcription failed:", error);
        process.exit(1);
    }
}

main();

