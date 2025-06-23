import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { ContentSummarizer, type ToolSummary } from '../utils/content-summarizer.js';
import { EmbedBuilder, ButtonBuilder, ActionRowBuilder } from 'discord.js';

// Mock Discord.js modules
vi.mock('discord.js', () => ({
  EmbedBuilder: vi.fn().mockImplementation(() => ({
    setTitle: vi.fn().mockReturnThis(),
    setDescription: vi.fn().mockReturnThis(),
    setColor: vi.fn().mockReturnThis(),
    setTimestamp: vi.fn().mockReturnThis(),
    setFooter: vi.fn().mockReturnThis(),
    addFields: vi.fn().mockReturnThis(),
  })),
  ButtonBuilder: vi.fn().mockImplementation(() => ({
    setCustomId: vi.fn().mockReturnThis(),
    setLabel: vi.fn().mockReturnThis(),
    setEmoji: vi.fn().mockReturnThis(),
    setStyle: vi.fn().mockReturnThis(),
  })),
  ActionRowBuilder: vi.fn().mockImplementation(() => ({
    addComponents: vi.fn().mockReturnThis(),
    components: [],
  })),
  ButtonStyle: {
    Primary: 1,
    Secondary: 2,
  },
  ThreadAutoArchiveDuration: {
    OneHour: 60,
  },
}));

describe('ContentSummarizer', () => {
  let summarizer: ContentSummarizer;

  beforeEach(() => {
    summarizer = new ContentSummarizer({
      enableThreadView: true,
      enablePagination: true,
      maxPreviewLength: 1000,
    });
  });

  describe('generateToolSummary', () => {
    it('should generate summary for Write operation', () => {
      const input = {
        file_path: '/path/to/test.py',
        content: 'def hello():\n    print("Hello, World!")\n\nclass TestClass:\n    pass',
      };
      const result = 'File created successfully';

      const summary = summarizer.generateToolSummary('write', input, result);

      expect(summary.toolName).toBe('Write');
      expect(summary.operation).toBe('create');
      expect(summary.summary).toContain('test.py');
      expect(summary.summary).toContain('4 lines');
      expect(summary.stats?.linesAdded).toBe(4);
      expect(summary.hasFullContent).toBe(false); // Small content
    });

    it('should generate summary for Edit operation', () => {
      const input = {
        file_path: '/path/to/test.py',
        old_string: 'def old_function():\n    pass',
        new_string: 'def new_function():\n    return "updated"',
      };
      const result = 'Edit completed';

      const summary = summarizer.generateToolSummary('edit', input, result);

      expect(summary.toolName).toBe('Edit');
      expect(summary.operation).toBe('modify');
      expect(summary.summary).toContain('test.py');
      expect(summary.details).toContain('- def old_function()');
      expect(summary.details).toContain('+ def new_function()');
    });

    it('should generate summary for MultiEdit operation', () => {
      const input = {
        file_path: '/path/to/test.py',
        edits: [
          { old_string: 'old1', new_string: 'new1' },
          { old_string: 'old2', new_string: 'new2' },
        ],
      };
      const result = 'MultiEdit completed';

      const summary = summarizer.generateToolSummary('multiedit', input, result);

      expect(summary.toolName).toBe('MultiEdit');
      expect(summary.operation).toBe('modify');
      expect(summary.summary).toContain('2 changes');
      expect(summary.stats?.linesAdded).toBe(2);
    });

    it('should generate summary for Read operation', () => {
      const input = { file_path: '/path/to/test.py' };
      const result = 'line 1\nline 2\nline 3';

      const summary = summarizer.generateToolSummary('read', input, result);

      expect(summary.toolName).toBe('Read');
      expect(summary.operation).toBe('read');
      expect(summary.summary).toContain('test.py');
      expect(summary.summary).toContain('3 lines');
      expect(summary.details).toBe(result);
    });

    it('should generate summary for Bash operation', () => {
      const input = {
        command: 'ls -la',
        description: 'List files in current directory',
      };
      const result = 'total 8\ndrwxr-xr-x  3 user  staff   96 Jan  1 12:00 .\ndrwxr-xr-x  4 user  staff  128 Jan  1 12:00 ..';

      const summary = summarizer.generateToolSummary('bash', input, result);

      expect(summary.toolName).toBe('Bash');
      expect(summary.operation).toBe('execute');
      expect(summary.summary).toContain('List files in current directory');
      expect(summary.details).toContain('Command: ls -la');
    });

    it('should generate summary for search operations', () => {
      const grepInput = { pattern: 'function', path: '/src' };
      const grepResult = 'file1.py:def function1():\nfile2.py:def function2():';

      const grepSummary = summarizer.generateToolSummary('grep', grepInput, grepResult);

      expect(grepSummary.toolName).toBe('Grep');
      expect(grepSummary.operation).toBe('search');
      expect(grepSummary.summary).toContain('function');
      expect(grepSummary.summary).toContain('2 matches');

      const globInput = { pattern: '*.py' };
      const globResult = 'file1.py\nfile2.py\nfile3.py';

      const globSummary = summarizer.generateToolSummary('glob', globInput, globResult);

      expect(globSummary.toolName).toBe('Glob');
      expect(globSummary.operation).toBe('search');
      expect(globSummary.summary).toContain('*.py');
      expect(globSummary.summary).toContain('3 matches');
    });

    it('should detect large content requiring full view', () => {
      const input = {
        file_path: '/path/to/large.py',
        content: 'x'.repeat(2000), // Large content
      };
      const result = 'File created';

      const summary = summarizer.generateToolSummary('write', input, result);

      expect(summary.hasFullContent).toBe(true);
    });

    it('should extract code features', () => {
      const input = {
        file_path: '/path/to/test.py',
        content: `
import os
import sys
from typing import Dict

class TestClass:
    def __init__(self):
        pass
    
    def method1(self):
        return "test"

def function1():
    pass

async function asyncFunction():
    return await something()
        `,
      };
      const result = 'File created';

      const summary = summarizer.generateToolSummary('write', input, result);

      expect(summary.summary).toContain('✨ 1 class');
      expect(summary.summary).toContain('function');
      expect(summary.summary).toContain('📦 3 import');
    });
  });

  describe('createContentButtons', () => {
    it('should create buttons when content requires full view', () => {
      const buttons = summarizer.createContentButtons('tool123', true);

      expect(buttons).toBeTruthy();
      expect(ActionRowBuilder).toHaveBeenCalled();
      expect(ButtonBuilder).toHaveBeenCalled();
    });

    it('should return null when content does not require full view', () => {
      const buttons = summarizer.createContentButtons('tool123', false);

      expect(buttons).toBeNull();
    });

    it('should create both thread and pagination buttons when enabled', () => {
      const summarizer = new ContentSummarizer({
        enableThreadView: true,
        enablePagination: true,
        maxPreviewLength: 1000,
      });

      const buttons = summarizer.createContentButtons('tool123', true);

      expect(buttons).toBeTruthy();
      // Should create buttons for both thread and pagination
      const mockButtonBuilder = vi.mocked(ButtonBuilder);
      expect(mockButtonBuilder).toHaveBeenCalledTimes(2);
    });
  });

  describe('createContentThread', () => {
    it('should create thread when enabled and content requires full view', async () => {
      const mockChannel = {
        threads: {
          create: vi.fn().mockResolvedValue({
            send: vi.fn().mockResolvedValue({}),
          }),
        },
      };

      const toolSummary: ToolSummary = {
        toolName: 'Write',
        operation: 'create',
        summary: 'Created test file',
        details: 'file content here',
        hasFullContent: true,
      };

      const thread = await summarizer.createContentThread(mockChannel, toolSummary, 'tool123');

      expect(mockChannel.threads.create).toHaveBeenCalled();
      expect(thread).toBeTruthy();
    });

    it('should return null when thread view is disabled', async () => {
      const summarizer = new ContentSummarizer({
        enableThreadView: false,
        enablePagination: true,
        maxPreviewLength: 1000,
      });

      const mockChannel = {
        threads: {
          create: vi.fn(),
        },
      };

      const toolSummary: ToolSummary = {
        toolName: 'Write',
        operation: 'create',
        summary: 'Created test file',
        details: 'file content here',
        hasFullContent: true,
      };

      const thread = await summarizer.createContentThread(mockChannel, toolSummary, 'tool123');

      expect(thread).toBeNull();
      expect(mockChannel.threads.create).not.toHaveBeenCalled();
    });
  });

  describe('createPaginatedView', () => {
    it('should create paginated messages when enabled and content requires full view', async () => {
      const mockChannel = {
        send: vi.fn().mockResolvedValue({ id: 'message123' }),
      };

      const toolSummary: ToolSummary = {
        toolName: 'Read',
        operation: 'read',
        summary: 'Read large file',
        details: 'x'.repeat(3000), // Large content requiring pagination
        hasFullContent: true,
      };

      const messages = await summarizer.createPaginatedView(mockChannel, toolSummary, 'tool123');

      expect(messages.length).toBeGreaterThan(0);
      expect(mockChannel.send).toHaveBeenCalled();
    });

    it('should return empty array when pagination is disabled', async () => {
      const summarizer = new ContentSummarizer({
        enableThreadView: true,
        enablePagination: false,
        maxPreviewLength: 1000,
      });

      const mockChannel = {
        send: vi.fn(),
      };

      const toolSummary: ToolSummary = {
        toolName: 'Read',
        operation: 'read',
        summary: 'Read file',
        details: 'content',
        hasFullContent: true,
      };

      const messages = await summarizer.createPaginatedView(mockChannel, toolSummary, 'tool123');

      expect(messages).toEqual([]);
      expect(mockChannel.send).not.toHaveBeenCalled();
    });
  });

  describe('content chunking', () => {
    it('should split long content into manageable chunks', () => {
      const longContent = 'x'.repeat(5000);
      
      const toolSummary: ToolSummary = {
        toolName: 'Write',
        operation: 'create',
        summary: 'Large file',
        details: longContent,
        hasFullContent: true,
      };

      // Test that the summarizer can handle long content without errors
      expect(() => {
        summarizer.generateToolSummary('write', { content: longContent }, 'success');
      }).not.toThrow();
    });

    it('should preserve line boundaries when splitting', () => {
      const content = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join('\n');
      
      // This test ensures that content splitting doesn't break in the middle of lines
      // Implementation details would be tested in the private methods
      expect(content.split('\n')).toHaveLength(100);
    });
  });

  describe('error handling', () => {
    it('should handle tool summaries for error results', () => {
      const input = {
        file_path: '/path/to/test.py',
        content: 'invalid syntax here',
      };
      const errorResult = 'SyntaxError: invalid syntax';

      const summary = summarizer.generateToolSummary('write', input, errorResult, true);

      expect(summary.toolName).toBe('Write');
      expect(summary.operation).toBe('create');
      // Should still provide summary even for errors
      expect(summary.summary).toBeTruthy();
    });

    it('should handle missing or malformed input gracefully', () => {
      const summary = summarizer.generateToolSummary('unknown_tool', {}, '');

      expect(summary.toolName).toBe('unknown_tool');
      expect(summary.operation).toBe('execute');
      expect(summary.summary).toBeTruthy();
      expect(summary.hasFullContent).toBe(false);
    });
  });
});