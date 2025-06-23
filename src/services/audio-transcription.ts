import * as fs from 'fs';
import * as path from 'path';
import type { Message, Attachment } from 'discord.js';

export class AudioTranscriptionService {
  private readonly tempDir: string;
  private readonly modelsDir: string;
  private readonly maxFileSize: number = 25 * 1024 * 1024; // 25MB Discord limit
  private readonly supportedFormats = ['audio/mp3', 'audio/wav', 'audio/ogg', 'audio/m4a', 'audio/mpeg'];
  private readonly modelName = 'ggml-base.en.bin';
  private readonly modelUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';

  constructor() {
    this.tempDir = path.join(process.cwd(), 'temp', 'audio');
    this.modelsDir = path.join(process.cwd(), 'models');
    this.ensureTempDirExists();
    this.ensureModelsDirExists();
  }

  private ensureTempDirExists(): void {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  private ensureModelsDirExists(): void {
    if (!fs.existsSync(this.modelsDir)) {
      fs.mkdirSync(this.modelsDir, { recursive: true });
    }
  }

  /**
   * Download whisper.cpp model if not exists
   */
  private async ensureModelExists(): Promise<string> {
    const modelPath = path.join(this.modelsDir, this.modelName);
    
    if (fs.existsSync(modelPath)) {
      console.log(`Whisper model already exists: ${modelPath}`);
      return modelPath;
    }

    console.log(`Downloading Whisper model from ${this.modelUrl}...`);
    
    try {
      const response = await fetch(this.modelUrl);
      
      if (!response.ok) {
        throw new Error(`Failed to download model: ${response.status} ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      
      fs.writeFileSync(modelPath, buffer);
      console.log(`Whisper model downloaded successfully: ${modelPath}`);
      
      return modelPath;
    } catch (error) {
      throw new Error(`Failed to download Whisper model: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
   * Install whisper.cpp if not available
   */
  private async ensureWhisperCppExists(): Promise<string> {
    const { spawn } = await import('child_process');
    
    return new Promise<string>((resolve, reject) => {
      // Check if whisper-cli is installed  
      const checkProcess = spawn('which', ['whisper-cli']);
      
      checkProcess.on('close', (code) => {
        if (code === 0) {
          resolve('whisper-cli');
          return;
        }
        
        // Try to install via Homebrew
        console.log('Installing whisper.cpp via Homebrew...');
        const installProcess = spawn('brew', ['install', 'whisper-cpp']);
        
        installProcess.on('close', (installCode) => {
          if (installCode === 0) {
            resolve('whisper-cli');
          } else {
            reject(new Error('Failed to install whisper.cpp. Please install manually: brew install whisper-cpp'));
          }
        });
        
        installProcess.on('error', () => {
          reject(new Error('Failed to install whisper.cpp. Please install manually: brew install whisper-cpp'));
        });
      });
      
      checkProcess.on('error', () => {
        reject(new Error('Failed to check whisper.cpp installation'));
      });
    });
  }

  /**
   * Transcribe audio file using local whisper.cpp with automatic model download
   */
  async transcribeAudio(audioFilePath: string): Promise<string> {
    try {
      // Ensure whisper.cpp is installed
      const whisperCommand = await this.ensureWhisperCppExists();
      
      // Ensure model is downloaded
      const modelPath = await this.ensureModelExists();
      
      const { spawn } = await import('child_process');
      
      return new Promise<string>((resolve, reject) => {
        const whisperProcess = spawn(whisperCommand, [
          '--model', modelPath,
          '--file', audioFilePath,
          '--no-prints',      // Only output transcription
          '--no-timestamps'   // Clean text output
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
            // With --no-prints and --no-timestamps, output should be clean transcription text
            const transcription = output.trim();
            
            if (transcription && transcription.length > 0) {
              resolve(transcription);
            } else {
              reject(new Error(`No transcription text found. Output: "${output}", Error: "${errorOutput}"`));
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