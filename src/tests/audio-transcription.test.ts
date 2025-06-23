import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AudioTranscriptionService } from '../services/audio-transcription.js';
import * as fs from 'fs';
import * as path from 'path';

describe('AudioTranscriptionService', () => {
  let service: AudioTranscriptionService;
  let tempDir: string;

  beforeEach(() => {
    service = new AudioTranscriptionService();
    tempDir = path.join(process.cwd(), 'temp', 'audio-tests');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up temp files
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('isAudioMessage', () => {
    it('should detect voice messages correctly', () => {
      const voiceMessage = {
        attachments: {
          size: 1,
          first: () => ({
            contentType: 'audio/mp3',
            size: 1024 * 1024, // 1MB
            url: 'https://example.com/audio.mp3'
          })
        },
        flags: { has: (flag: number) => flag === 8192 } // IsVoiceMessage flag
      };

      expect(service.isAudioMessage(voiceMessage as any)).toBe(true);
    });

    it('should detect regular audio attachments', () => {
      const audioMessage = {
        attachments: {
          size: 1,
          first: () => ({
            contentType: 'audio/wav',
            size: 1024 * 1024, // 1MB
            url: 'https://example.com/audio.wav'
          })
        },
        flags: { has: (flag: number) => false }
      };

      expect(service.isAudioMessage(audioMessage as any)).toBe(true);
    });

    it('should reject non-audio attachments', () => {
      const imageMessage = {
        attachments: {
          size: 1,
          first: () => ({
            contentType: 'image/png',
            size: 1024 * 1024,
            url: 'https://example.com/image.png'
          })
        },
        flags: { has: (flag: number) => false }
      };

      expect(service.isAudioMessage(imageMessage as any)).toBe(false);
    });

    it('should reject messages without attachments', () => {
      const textMessage = {
        attachments: { size: 0 },
        flags: { has: (flag: number) => false }
      };

      expect(service.isAudioMessage(textMessage as any)).toBe(false);
    });

    it('should reject audio files that are too large', () => {
      const largeAudioMessage = {
        attachments: {
          size: 1,
          first: () => ({
            contentType: 'audio/mp3',
            size: 30 * 1024 * 1024, // 30MB - over Discord limit
            url: 'https://example.com/large-audio.mp3'
          })
        },
        flags: { has: (flag: number) => false }
      };

      expect(service.isAudioMessage(largeAudioMessage as any)).toBe(false);
    });
  });

  describe('downloadAudioAttachment', () => {
    it('should create a unique temp file path', async () => {
      const attachment = {
        url: 'https://example.com/audio.mp3',
        name: 'test-audio.mp3'
      };

      // Mock fetch to return a successful response
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(1024))
      });

      const filePath = await service.downloadAudioAttachment(attachment as any);
      
      expect(filePath).toMatch(/temp[\/\\]audio[\/\\]discord-audio-\d+-test-audio\.mp3$/);
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('should handle download failures gracefully', async () => {
      const attachment = {
        url: 'https://example.com/nonexistent.mp3',
        name: 'test.mp3'
      };

      // Mock fetch to return a failed response
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 404
      });

      await expect(service.downloadAudioAttachment(attachment as any))
        .rejects.toThrow('Failed to download audio file: 404');
    });
  });

  describe('transcribeAudio', () => {
    it('should transcribe audio file and return text', async () => {
      // Create a mock audio file
      const testAudioPath = path.join(tempDir, 'test.mp3');
      fs.writeFileSync(testAudioPath, Buffer.from('fake audio data'));

      // Mock child_process spawn
      const mockSpawn = vi.fn().mockReturnValue({
        stdout: {
          on: vi.fn((event, callback) => {
            if (event === 'data') {
              setTimeout(() => callback('{"text": "Hello world, this is a test transcription."}\n'), 10);
            }
          })
        },
        stderr: {
          on: vi.fn()
        },
        on: vi.fn((event, callback) => {
          if (event === 'close') {
            setTimeout(() => callback(0), 20);
          }
        })
      });

      vi.doMock('child_process', () => ({
        spawn: mockSpawn
      }));

      const result = await service.transcribeAudio(testAudioPath);
      
      expect(result).toBe('Hello world, this is a test transcription.');
    });

    it('should handle transcription errors', async () => {
      const testAudioPath = path.join(tempDir, 'invalid.mp3');
      fs.writeFileSync(testAudioPath, Buffer.from('invalid audio data'));

      // Mock child_process spawn to fail
      const mockSpawn = vi.fn().mockReturnValue({
        stdout: {
          on: vi.fn()
        },
        stderr: {
          on: vi.fn((event, callback) => {
            if (event === 'data') {
              setTimeout(() => callback('Invalid audio format'), 10);
            }
          })
        },
        on: vi.fn((event, callback) => {
          if (event === 'close') {
            setTimeout(() => callback(1), 20); // Non-zero exit code
          }
        })
      });

      vi.doMock('child_process', () => ({
        spawn: mockSpawn
      }));

      await expect(service.transcribeAudio(testAudioPath))
        .rejects.toThrow('Transcription failed: Whisper process failed (code 1): Invalid audio format');
    });
  });

  describe('cleanupTempFile', () => {
    it('should remove temporary files', () => {
      const tempFile = path.join(tempDir, 'temp-audio.mp3');
      fs.writeFileSync(tempFile, 'test data');
      
      expect(fs.existsSync(tempFile)).toBe(true);
      
      service.cleanupTempFile(tempFile);
      
      expect(fs.existsSync(tempFile)).toBe(false);
    });

    it('should handle cleanup errors gracefully', () => {
      const nonExistentFile = path.join(tempDir, 'does-not-exist.mp3');
      
      // Should not throw
      expect(() => service.cleanupTempFile(nonExistentFile)).not.toThrow();
    });
  });

  describe('processAudioMessage', () => {
    it('should process voice message end-to-end', async () => {
      const mockMessage = {
        attachments: {
          size: 1,
          first: () => ({
            contentType: 'audio/mp3',
            size: 1024 * 1024,
            url: 'https://example.com/voice.mp3',
            name: 'voice.mp3'
          })
        },
        flags: { has: (flag: number) => flag === 8192 }
      };

      // Mock fetch for download
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(1024))
      });

      // Mock child_process spawn for transcription
      const mockSpawn = vi.fn().mockReturnValue({
        stdout: {
          on: vi.fn((event, callback) => {
            if (event === 'data') {
              setTimeout(() => callback('{"text": "Transcribed voice message"}\n'), 10);
            }
          })
        },
        stderr: {
          on: vi.fn()
        },
        on: vi.fn((event, callback) => {
          if (event === 'close') {
            setTimeout(() => callback(0), 20);
          }
        })
      });

      vi.doMock('child_process', () => ({
        spawn: mockSpawn
      }));

      const result = await service.processAudioMessage(mockMessage as any);
      
      expect(result).toBe('Transcribed voice message');
    });

    it('should reject non-audio messages', async () => {
      const textMessage = {
        attachments: { size: 0 },
        flags: { has: (flag: number) => false }
      };

      await expect(service.processAudioMessage(textMessage as any))
        .rejects.toThrow('Message does not contain a valid audio attachment');
    });
  });
});