import * as fs from 'fs';
import * as path from 'path';
import type { Message, Attachment } from 'discord.js';

export class AudioTranscriptionService {
  private readonly tempDir: string;
  private readonly maxFileSize: number = 25 * 1024 * 1024; // 25MB Discord limit
  private readonly supportedFormats = ['audio/mp3', 'audio/wav', 'audio/ogg', 'audio/m4a', 'audio/mpeg'];
  private modelDownloaded: boolean = false;

  constructor() {
    this.tempDir = path.join(process.cwd(), 'temp', 'audio');
    this.ensureTempDirExists();
  }

  private ensureTempDirExists(): void {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Check if a Discord message contains a valid audio attachment
   */
  isAudioMessage(message: Message): boolean {
    if (message.attachments.size === 0) {
      return false;
    }

    const attachment = message.attachments.first();
    if (!attachment) {
      return false;
    }

    // Check if it's a voice message (Discord flag 8192 = IsVoiceMessage)
    const isVoiceMessage = message.flags?.has(8192) || false;
    
    // Check if it's an audio file
    const isAudioFile = attachment.contentType && 
      this.supportedFormats.includes(attachment.contentType);

    // Check file size
    const withinSizeLimit = attachment.size <= this.maxFileSize;

    return (isVoiceMessage || isAudioFile) && withinSizeLimit;
  }

  /**
   * Download audio attachment to temporary file
   */
  async downloadAudioAttachment(attachment: Attachment): Promise<string> {
    const timestamp = Date.now();
    const fileName = `discord-audio-${timestamp}-${attachment.name || 'audio.mp3'}`;
    const filePath = path.join(this.tempDir, fileName);

    try {
      const response = await fetch(attachment.url);
      
      if (!response.ok) {
        throw new Error(`Failed to download audio file: ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      
      fs.writeFileSync(filePath, buffer);
      
      return filePath;
    } catch (error) {
      throw new Error(`Failed to download audio attachment: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Transcribe audio file using local Python Whisper (uses existing downloaded models)
   */
  async transcribeAudio(audioFilePath: string): Promise<string> {
    try {
      // Use Python Whisper directly since models are already downloaded
      const { spawn } = await import('child_process');
      
      return new Promise<string>((resolve, reject) => {
        const whisperProcess = spawn('python3', [
          '-c',
          `
import whisper
import sys
import json

model = whisper.load_model("base")
result = model.transcribe("${audioFilePath}")
print(json.dumps({"text": result["text"]}))
          `
        ]);

        let output = '';
        let errorOutput = '';

        whisperProcess.stdout.on('data', (data) => {
          output += data.toString();
        });

        whisperProcess.stderr.on('data', (data) => {
          errorOutput += data.toString();
        });

        whisperProcess.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`Whisper process failed (code ${code}): ${errorOutput}`));
            return;
          }

          try {
            // Parse the JSON output from Python
            const lines = output.trim().split('\n');
            const lastLine = lines[lines.length - 1];
            const result = JSON.parse(lastLine);
            
            if (result.text) {
              resolve(result.text.trim());
            } else {
              reject(new Error('No text in transcription result'));
            }
          } catch (parseError) {
            reject(new Error(`Failed to parse transcription result: ${parseError}`));
          }
        });

        whisperProcess.on('error', (error) => {
          reject(new Error(`Failed to start Whisper process: ${error.message}`));
        });
      });
      
    } catch (error) {
      throw new Error(`Transcription failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Clean up temporary audio file
   */
  cleanupTempFile(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`Cleaned up temp file: ${filePath}`);
      }
    } catch (error) {
      console.error(`Failed to cleanup temp file ${filePath}:`, error);
    }
  }

  /**
   * Process audio message end-to-end: download, transcribe, cleanup
   */
  async processAudioMessage(message: Message): Promise<string> {
    if (!this.isAudioMessage(message)) {
      throw new Error('Message does not contain a valid audio attachment');
    }

    const attachment = message.attachments.first()!;
    let tempFilePath: string | null = null;

    try {
      console.log(`Processing audio attachment: ${attachment.name} (${attachment.size} bytes)`);
      
      // Download audio file
      tempFilePath = await this.downloadAudioAttachment(attachment);
      console.log(`Downloaded audio to: ${tempFilePath}`);
      
      // Transcribe audio
      const transcription = await this.transcribeAudio(tempFilePath);
      console.log(`Transcription completed: ${transcription.substring(0, 100)}...`);
      
      return transcription;
      
    } finally {
      // Always cleanup temp file
      if (tempFilePath) {
        this.cleanupTempFile(tempFilePath);
      }
    }
  }

  /**
   * Get supported audio formats
   */
  getSupportedFormats(): string[] {
    return [...this.supportedFormats];
  }
}