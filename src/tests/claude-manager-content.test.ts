import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ClaudeManager } from '../claude/manager.js';
import { ContentSummarizer } from '../utils/content-summarizer.js';
import { EmbedBuilder } from 'discord.js';

// Mock dependencies
vi.mock('../db/database.js', () => ({
  DatabaseManager: vi.fn().mockImplementation(() => ({
    cleanupOldSessions: vi.fn(),
    getSession: vi.fn(),
    setSession: vi.fn(),
    clearSession: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock('../utils/content-summarizer.js', () => ({
  ContentSummarizer: vi.fn().mockImplementation(() => ({
    generateToolSummary: vi.fn(),
    createContentButtons: vi.fn(),
    createContentThread: vi.fn(),
    createPaginatedView: vi.fn(),
  })),
}));

vi.mock('discord.js', () => ({
  EmbedBuilder: vi.fn().mockImplementation(() => ({
    setTitle: vi.fn().mockReturnThis(),
    setDescription: vi.fn().mockReturnThis(),
    setColor: vi.fn().mockReturnThis(),
    setTimestamp: vi.fn().mockReturnThis(),
    addFields: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('{}'),
  appendFileSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

describe('ClaudeManager Content Handling', () => {
  let claudeManager: ClaudeManager;
  let mockContentSummarizer: any;

  beforeEach(() => {
    claudeManager = new ClaudeManager('/test/base/folder');
    mockContentSummarizer = vi.mocked(ContentSummarizer).mock.instances[0];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('tool summary storage', () => {
    it('should store tool summary for content viewing', () => {
      const channelId = 'channel123';
      const toolId = 'tool456';
      const summary = {
        toolName: 'Write',
        operation: 'create',
        summary: 'Created test.py',
        hasFullContent: true,
      };

      // Use private method via type assertion for testing
      (claudeManager as any).storeToolSummary(channelId, toolId, summary);

      const retrieved = claudeManager.getToolSummary(channelId, toolId);
      expect(retrieved).toEqual(summary);
    });

    it('should return undefined for non-existent tool summary', () => {
      const retrieved = claudeManager.getToolSummary('nonexistent', 'tool');
      expect(retrieved).toBeUndefined();
    });

    it('should clear tool summaries when session is cleared', () => {
      const channelId = 'channel123';
      const toolId = 'tool456';
      const summary = { toolName: 'Test', hasFullContent: true };

      (claudeManager as any).storeToolSummary(channelId, toolId, summary);
      expect(claudeManager.getToolSummary(channelId, toolId)).toBeTruthy();

      claudeManager.clearSession(channelId);
      expect(claudeManager.getToolSummary(channelId, toolId)).toBeUndefined();
    });
  });

  describe('handleContentViewButton', () => {
    const mockInteraction = {
      reply: vi.fn(),
      channel: {
        threads: {
          create: vi.fn().mockResolvedValue({
            send: vi.fn(),
            toString: () => '<#thread123>',
          }),
        },
        send: vi.fn().mockResolvedValue({ id: 'msg123' }),
      },
    };

    beforeEach(() => {
      mockInteraction.reply.mockClear();
      mockContentSummarizer.createContentThread.mockClear();
      mockContentSummarizer.createPaginatedView.mockClear();
    });

    it('should handle thread view button interaction', async () => {
      const channelId = 'channel123';
      const toolId = 'tool456';
      const summary = {
        toolName: 'Write',
        operation: 'create',
        summary: 'Created large file',
        hasFullContent: true,
        details: 'Large file content...',
      };

      (claudeManager as any).storeToolSummary(channelId, toolId, summary);
      mockContentSummarizer.createContentThread.mockResolvedValue(
        mockInteraction.channel.threads.create()
      );

      await claudeManager.handleContentViewButton(
        channelId,
        toolId,
        'thread',
        mockInteraction
      );

      expect(mockContentSummarizer.createContentThread).toHaveBeenCalledWith(
        mockInteraction.channel,
        summary,
        toolId
      );
      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: expect.stringContaining('Full content available'),
        ephemeral: true,
      });
    });

    it('should handle paginated view button interaction', async () => {
      const channelId = 'channel123';
      const toolId = 'tool456';
      const summary = {
        toolName: 'Read',
        operation: 'read',
        summary: 'Read large file',
        hasFullContent: true,
        details: 'Large file content...',
      };

      (claudeManager as any).storeToolSummary(channelId, toolId, summary);
      mockContentSummarizer.createPaginatedView.mockResolvedValue([
        { id: 'msg1' },
        { id: 'msg2' },
      ]);

      await claudeManager.handleContentViewButton(
        channelId,
        toolId,
        'paginate',
        mockInteraction
      );

      expect(mockContentSummarizer.createPaginatedView).toHaveBeenCalledWith(
        mockInteraction.channel,
        summary,
        toolId
      );
      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: expect.stringContaining('Content displayed in 2 pages'),
        ephemeral: true,
      });
    });

    it('should handle missing tool summary gracefully', async () => {
      await claudeManager.handleContentViewButton(
        'nonexistent',
        'tool456',
        'thread',
        mockInteraction
      );

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: 'Content not found or expired',
        ephemeral: true,
      });
    });

    it('should handle thread creation failure', async () => {
      const channelId = 'channel123';
      const toolId = 'tool456';
      const summary = { toolName: 'Write', hasFullContent: true };

      (claudeManager as any).storeToolSummary(channelId, toolId, summary);
      mockContentSummarizer.createContentThread.mockResolvedValue(null);

      await claudeManager.handleContentViewButton(
        channelId,
        toolId,
        'thread',
        mockInteraction
      );

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: 'Failed to create thread',
        ephemeral: true,
      });
    });

    it('should handle errors during content view operations', async () => {
      const channelId = 'channel123';
      const toolId = 'tool456';
      const summary = { toolName: 'Write', hasFullContent: true };

      (claudeManager as any).storeToolSummary(channelId, toolId, summary);
      mockContentSummarizer.createContentThread.mockRejectedValue(
        new Error('Thread creation failed')
      );

      await claudeManager.handleContentViewButton(
        channelId,
        toolId,
        'thread',
        mockInteraction
      );

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: 'Error displaying content',
        ephemeral: true,
      });
    });
  });

  describe('tool result message handling with summaries', () => {
    const mockChannel = {
      send: vi.fn().mockResolvedValue({ id: 'msg123' }),
    };

    const mockToolMessage = {
      embeds: [
        {
          data: {
            description: '⏳ 🔧 Write (file_path=test.py)',
          },
        },
      ],
      edit: vi.fn(),
    };

    beforeEach(() => {
      claudeManager.setDiscordMessage('channel123', { channel: mockChannel });
      
      // Set up tool calls tracking
      const toolCalls = new Map();
      toolCalls.set('tool456', {
        message: mockToolMessage,
        toolId: 'tool456',
        toolName: 'Write',
        input: { file_path: 'test.py', content: 'test content' },
      });
      (claudeManager as any).channelToolCalls.set('channel123', toolCalls);

      mockContentSummarizer.generateToolSummary.mockReturnValue({
        toolName: 'Write',
        operation: 'create',
        summary: '📄 Created test.py (2 lines, 0.01KB)',
        hasFullContent: true,
      });

      mockContentSummarizer.createContentButtons.mockReturnValue({
        components: [{}], // Mock button row
      });
    });

    it('should generate and display tool summary on successful completion', async () => {
      const toolResultMessage = {
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool456',
              content: 'File created successfully',
              is_error: false,
            },
          ],
        },
      };

      await (claudeManager as any).handleToolResultMessage('channel123', toolResultMessage);

      expect(mockContentSummarizer.generateToolSummary).toHaveBeenCalledWith(
        'Write',
        { file_path: 'test.py', content: 'test content' },
        'File created successfully',
        false
      );

      expect(mockToolMessage.edit).toHaveBeenCalledWith({
        embeds: [expect.any(Object)],
        components: [expect.any(Object)],
      });
    });

    it('should handle error results appropriately', async () => {
      mockContentSummarizer.generateToolSummary.mockReturnValue({
        toolName: 'Write',
        operation: 'create',
        summary: '❌ Failed to create test.py',
        hasFullContent: false,
      });

      mockContentSummarizer.createContentButtons.mockReturnValue(null);

      const toolResultMessage = {
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool456',
              content: 'Permission denied: cannot write to file',
              is_error: true,
            },
          ],
        },
      };

      await (claudeManager as any).handleToolResultMessage('channel123', toolResultMessage);

      expect(mockContentSummarizer.generateToolSummary).toHaveBeenCalledWith(
        'Write',
        expect.any(Object),
        'Permission denied: cannot write to file',
        true
      );

      expect(mockToolMessage.edit).toHaveBeenCalledWith({
        embeds: [expect.objectContaining({})],
        // No components for error without full content
      });
    });

    it('should store tool summary when hasFullContent is true', async () => {
      const toolResultMessage = {
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool456',
              content: 'Large file content...',
              is_error: false,
            },
          ],
        },
      };

      await (claudeManager as any).handleToolResultMessage('channel123', toolResultMessage);

      const storedSummary = claudeManager.getToolSummary('channel123', 'tool456');
      expect(storedSummary).toBeTruthy();
      expect(storedSummary.hasFullContent).toBe(true);
    });
  });

  describe('integration with content viewing features', () => {
    it('should maintain tool summaries across multiple operations', () => {
      const channelId = 'channel123';
      
      // Store multiple tool summaries
      const writeSum = { toolName: 'Write', hasFullContent: true };
      const readSum = { toolName: 'Read', hasFullContent: true };
      
      (claudeManager as any).storeToolSummary(channelId, 'write1', writeSum);
      (claudeManager as any).storeToolSummary(channelId, 'read1', readSum);

      expect(claudeManager.getToolSummary(channelId, 'write1')).toEqual(writeSum);
      expect(claudeManager.getToolSummary(channelId, 'read1')).toEqual(readSum);
    });

    it('should handle memory cleanup properly', () => {
      const channelId = 'channel123';
      
      // Store some summaries
      (claudeManager as any).storeToolSummary(channelId, 'tool1', { toolName: 'Test1' });
      (claudeManager as any).storeToolSummary(channelId, 'tool2', { toolName: 'Test2' });

      expect(claudeManager.getToolSummary(channelId, 'tool1')).toBeTruthy();
      expect(claudeManager.getToolSummary(channelId, 'tool2')).toBeTruthy();

      // Clear session should clean up all summaries
      claudeManager.clearSession(channelId);

      expect(claudeManager.getToolSummary(channelId, 'tool1')).toBeUndefined();
      expect(claudeManager.getToolSummary(channelId, 'tool2')).toBeUndefined();
    });
  });
});