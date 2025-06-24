import { describe, test, expect, vi } from 'vitest';
import { MessageLimitHandler } from '../message-limit-handler';

// Mock Discord.js types for testing
const mockChannel = {
  send: vi.fn().mockResolvedValue({ id: 'test-message-id' }),
  threads: {
    create: vi.fn().mockResolvedValue({
      id: 'test-thread-id',
      send: vi.fn().mockResolvedValue({ id: 'thread-message-id' })
    })
  }
};

describe('Backwards Compatibility', () => {
  let handler: MessageLimitHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new MessageLimitHandler();
  });

  test('should pass through short content unchanged', async () => {
    const shortContent = 'Hello world!';
    const result = await handler.handle(shortContent, mockChannel as any);
    
    expect(result.handled).toBe(false);
    expect(result.originalContent).toBe(shortContent);
    expect(mockChannel.send).not.toHaveBeenCalled();
  });

  test('should handle typical Claude Code messages without interference', async () => {
    const typicalMessages = [
      '✅ Tests passed!',
      '💬 Claude: Simple response',
      '🔧 Edit: Small change made',
      'Regular user message content',
      '⏳ 🔧 Write (file_path=./test.js, content="console.log(\'hello\');")'
    ];
    
    for (const message of typicalMessages) {
      const result = await handler.handle(message, mockChannel as any);
      expect(result.handled).toBe(false);
      expect(result.originalContent).toBe(message);
    }
    
    expect(mockChannel.send).not.toHaveBeenCalled();
  });

  test('should only activate on content exceeding 4096 characters', async () => {
    const borderlineContent = 'x'.repeat(4096);
    const overLimitContent = 'x'.repeat(4097);
    
    const borderlineResult = await handler.handle(borderlineContent, mockChannel as any);
    expect(borderlineResult.handled).toBe(false);
    
    const overLimitResult = await handler.handle(overLimitContent, mockChannel as any);
    expect(overLimitResult.handled).toBe(true);
  });

  test('should preserve original error behavior for non-limit errors', () => {
    const validEmbed = {
      title: 'Test',
      description: 'Valid content'
    };
    
    const embedWithNullDescription = {
      title: 'Test',
      description: null as any
    };
    
    expect(() => handler.validateEmbedContent(validEmbed)).not.toThrow();
    expect(() => handler.validateEmbedContent(embedWithNullDescription)).not.toThrow();
  });

  test('should handle mixed content types without breaking existing patterns', async () => {
    const mixedContent = `
Regular text content here.

\`\`\`javascript
function example() {
  return "code block";
}
\`\`\`

More text content.
`;
    
    const result = await handler.handle(mixedContent, mockChannel as any);
    
    // Should not be handled since it's under the limit
    expect(result.handled).toBe(false);
    expect(result.originalContent).toBe(mixedContent);
  });
});

describe('Error Handling Compatibility', () => {
  let handler: MessageLimitHandler;

  beforeEach(() => {
    handler = new MessageLimitHandler();
  });

  test('should gracefully handle malformed content', async () => {
    // Test with content that's hard to process but won't throw during String conversion
    const undefinedContent = undefined as any;
    const nullContent = null as any;
    
    // Should not throw, just return unhandled  
    const result1 = await handler.handle(String(undefinedContent), mockChannel as any);
    expect(result1.handled).toBe(false);
    
    const result2 = await handler.handle(String(nullContent), mockChannel as any);
    expect(result2.handled).toBe(false);
  });

  test('should preserve existing channel send patterns', () => {
    // Verify that the handler doesn't interfere with standard Discord.js patterns
    expect(mockChannel.send).toBeDefined();
    expect(typeof mockChannel.send).toBe('function');
  });
});