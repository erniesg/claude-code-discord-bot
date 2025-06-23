import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { DiscordBot } from '../bot/client.js';
import { ClaudeManager } from '../claude/manager.js';
import { EmbedBuilder } from 'discord.js';

// Mock dependencies
vi.mock('../claude/manager.js', () => ({
  ClaudeManager: vi.fn().mockImplementation(() => ({
    hasActiveProcess: vi.fn().mockReturnValue(false),
    getSessionId: vi.fn(),
    setDiscordMessage: vi.fn(),
    reserveChannel: vi.fn(),
    runClaudeCode: vi.fn(),
    clearSession: vi.fn(),
    getToolSummary: vi.fn(),
    handleContentViewButton: vi.fn(),
  })),
}));

vi.mock('../bot/commands.js', () => ({
  CommandHandler: vi.fn().mockImplementation(() => ({
    registerCommands: vi.fn(),
    handleInteraction: vi.fn(),
  })),
}));

vi.mock('../services/audio-transcription.js', () => ({
  AudioTranscriptionService: vi.fn().mockImplementation(() => ({
    isAudioMessage: vi.fn().mockReturnValue(false),
    processAudioMessage: vi.fn(),
  })),
}));

vi.mock('discord.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    once: vi.fn(),
    on: vi.fn(),
    login: vi.fn(),
    user: { tag: 'TestBot#1234', id: 'bot123' },
  })),
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    GuildMessageReactions: 8,
  },
  EmbedBuilder: vi.fn().mockImplementation(() => ({
    setTitle: vi.fn().mockReturnThis(),
    setDescription: vi.fn().mockReturnThis(),
    setColor: vi.fn().mockReturnThis(),
    addFields: vi.fn().mockReturnThis(),
  })),
}));

describe('DiscordBot Button Interactions', () => {
  let discordBot: DiscordBot;
  let mockClaudeManager: any;
  let mockClient: any;
  const allowedUserId = 'user123';

  beforeEach(() => {
    mockClaudeManager = vi.mocked(ClaudeManager).mock.instances[0];
    discordBot = new DiscordBot(mockClaudeManager, allowedUserId);
    
    // Get the mocked client instance
    mockClient = (discordBot as any).client;
    
    // Clear all mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('button interaction authorization', () => {
    const createMockInteraction = (userId: string, customId: string) => ({
      user: { id: userId },
      customId,
      channelId: 'channel123',
      reply: vi.fn(),
      isButton: () => true,
      isCommand: () => false,
    });

    it('should reject unauthorized users', async () => {
      const mockInteraction = createMockInteraction('unauthorized_user', 'thread_tool123');
      
      // Simulate the button interaction handler
      await (discordBot as any).handleButtonInteraction(mockInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: 'You are not authorized to use this bot',
        ephemeral: true,
      });
      expect(mockClaudeManager.handleContentViewButton).not.toHaveBeenCalled();
    });

    it('should allow authorized users', async () => {
      const mockInteraction = createMockInteraction(allowedUserId, 'thread_tool123');
      mockClaudeManager.handleContentViewButton.mockResolvedValue(undefined);
      
      await (discordBot as any).handleButtonInteraction(mockInteraction);

      expect(mockInteraction.reply).not.toHaveBeenCalledWith({
        content: 'You are not authorized to use this bot',
        ephemeral: true,
      });
      expect(mockClaudeManager.handleContentViewButton).toHaveBeenCalled();
    });
  });

  describe('thread view button interactions', () => {
    const createAuthorizedInteraction = (customId: string) => ({
      user: { id: allowedUserId },
      customId,
      channelId: 'channel123',
      reply: vi.fn(),
      channel: { id: 'channel123' },
    });

    it('should handle thread button correctly', async () => {
      const mockInteraction = createAuthorizedInteraction('thread_tool456');
      mockClaudeManager.handleContentViewButton.mockResolvedValue(undefined);

      await (discordBot as any).handleButtonInteraction(mockInteraction);

      expect(mockClaudeManager.handleContentViewButton).toHaveBeenCalledWith(
        'channel123',
        'tool456',
        'thread',
        mockInteraction
      );
    });

    it('should handle pagination button correctly', async () => {
      const mockInteraction = createAuthorizedInteraction('paginate_tool789');
      mockClaudeManager.handleContentViewButton.mockResolvedValue(undefined);

      await (discordBot as any).handleButtonInteraction(mockInteraction);

      expect(mockClaudeManager.handleContentViewButton).toHaveBeenCalledWith(
        'channel123',
        'tool789',
        'paginate',
        mockInteraction
      );
    });

    it('should ignore malformed button IDs', async () => {
      const mockInteraction = createAuthorizedInteraction('invalid');
      
      await (discordBot as any).handleButtonInteraction(mockInteraction);

      expect(mockClaudeManager.handleContentViewButton).not.toHaveBeenCalled();
      // Should not crash or send error messages for malformed IDs
    });
  });

  describe('pagination navigation buttons', () => {
    const createPaginationInteraction = (customId: string) => ({
      user: { id: allowedUserId },
      customId,
      channelId: 'channel123',
      reply: vi.fn(),
    });

    beforeEach(() => {
      mockClaudeManager.getToolSummary.mockReturnValue({
        toolName: 'Read',
        operation: 'read',
        summary: 'Read large file',
        hasFullContent: true,
        stats: { linesAdded: 100, fileSize: '5KB' },
      });
    });

    it('should handle summary button', async () => {
      const mockInteraction = createPaginationInteraction('summary_tool123');

      await (discordBot as any).handlePaginationButton(
        mockInteraction,
        'summary',
        'tool123'
      );

      expect(mockClaudeManager.getToolSummary).toHaveBeenCalledWith(
        'channel123',
        'tool123'
      );
      expect(mockInteraction.reply).toHaveBeenCalledWith({
        embeds: [expect.any(Object)],
        ephemeral: true,
      });
    });

    it('should handle missing tool summary in pagination', async () => {
      mockClaudeManager.getToolSummary.mockReturnValue(null);
      const mockInteraction = createPaginationInteraction('summary_tool123');

      await (discordBot as any).handlePaginationButton(
        mockInteraction,
        'summary',
        'tool123'
      );

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: 'Content not found or expired',
        ephemeral: true,
      });
    });

    it('should handle prev/next pagination buttons', async () => {
      const mockInteraction = createPaginationInteraction('next_tool123_1');

      await (discordBot as any).handlePaginationButton(
        mockInteraction,
        'next',
        'tool123',
        '1'
      );

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: 'Pagination next - Feature coming soon!',
        ephemeral: true,
      });
    });
  });

  describe('error handling in button interactions', () => {
    const createErrorInteraction = (customId: string) => ({
      user: { id: allowedUserId },
      customId,
      channelId: 'channel123',
      reply: vi.fn(),
    });

    it('should handle errors in content view button processing', async () => {
      const mockInteraction = createErrorInteraction('thread_tool123');
      mockClaudeManager.handleContentViewButton.mockRejectedValue(
        new Error('Content view failed')
      );

      await (discordBot as any).handleButtonInteraction(mockInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: 'Error processing button interaction',
        ephemeral: true,
      });
    });

    it('should handle errors gracefully when reply fails', async () => {
      const mockInteraction = createErrorInteraction('thread_tool123');
      mockClaudeManager.handleContentViewButton.mockRejectedValue(
        new Error('Content view failed')
      );
      mockInteraction.reply.mockRejectedValue(new Error('Reply failed'));

      // Should not throw even if reply fails
      await expect((discordBot as any).handleButtonInteraction(mockInteraction)).resolves.toBeUndefined();
    });
  });

  describe('button interaction routing', () => {
    it('should route different interaction types correctly', async () => {
      const commandInteraction = {
        isCommand: () => true,
        isButton: () => false,
      };
      
      const buttonInteraction = {
        isCommand: () => false,
        isButton: () => true,
        user: { id: allowedUserId },
        customId: 'thread_tool123',
        channelId: 'channel123',
        reply: vi.fn(),
      };

      // Get the interaction handler that was registered
      const interactionHandler = mockClient.on.mock.calls.find(
        call => call[0] === 'interactionCreate'
      )?.[1];

      expect(interactionHandler).toBeDefined();

      // Test command routing
      const mockCommandHandler = (discordBot as any).commandHandler;
      mockCommandHandler.handleInteraction = vi.fn();
      
      await interactionHandler(commandInteraction);
      expect(mockCommandHandler.handleInteraction).toHaveBeenCalledWith(commandInteraction);

      // Test button routing
      mockClaudeManager.handleContentViewButton.mockResolvedValue(undefined);
      await interactionHandler(buttonInteraction);
      expect(mockClaudeManager.handleContentViewButton).toHaveBeenCalled();
    });
  });

  describe('integration with Claude manager', () => {
    it('should properly integrate with Claude manager for content viewing', async () => {
      const mockInteraction = {
        user: { id: allowedUserId },
        customId: 'thread_tool123',
        channelId: 'channel123',
        reply: vi.fn(),
        channel: { threads: { create: vi.fn() } },
      };

      // Simulate successful content view
      mockClaudeManager.handleContentViewButton.mockResolvedValue(undefined);

      await (discordBot as any).handleButtonInteraction(mockInteraction);

      expect(mockClaudeManager.handleContentViewButton).toHaveBeenCalledWith(
        'channel123',
        'tool123',
        'thread',
        mockInteraction
      );
    });

    it('should handle tool summary retrieval for pagination', async () => {
      const mockSummary = {
        toolName: 'Write',
        operation: 'create',
        summary: 'Created test file',
        stats: { linesAdded: 50 },
      };

      mockClaudeManager.getToolSummary.mockReturnValue(mockSummary);

      const mockInteraction = {
        user: { id: allowedUserId },
        customId: 'summary_tool123',
        channelId: 'channel123',
        reply: vi.fn(),
      };

      await (discordBot as any).handlePaginationButton(
        mockInteraction,
        'summary',
        'tool123'
      );

      expect(mockClaudeManager.getToolSummary).toHaveBeenCalledWith(
        'channel123',
        'tool123'
      );
      expect(mockInteraction.reply).toHaveBeenCalled();
    });
  });
});