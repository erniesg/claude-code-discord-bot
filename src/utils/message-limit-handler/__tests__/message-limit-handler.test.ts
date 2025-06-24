import { describe, test, expect, beforeEach, vi } from 'vitest';
import { MessageLimitHandler } from '../message-limit-handler';
import { ContentAnalyzer } from '../content-analyzer';
import { SmartSummarizer } from '../smart-summarizer';
import { ThreadManager } from '../thread-manager';
import { PaginationManager } from '../pagination-manager';
import type { Message, TextChannel, ThreadChannel } from 'discord.js';

// Discord limits
const DISCORD_EMBED_DESC_LIMIT = 4096;
const DISCORD_EMBED_TITLE_LIMIT = 256;
const DISCORD_EMBED_TOTAL_LIMIT = 6000;

// Mock Discord.js types
const mockMessage = {
  channel: {
    send: vi.fn(),
    isThread: vi.fn(() => false),
    threads: {
      create: vi.fn()
    }
  },
  edit: vi.fn(),
  react: vi.fn()
} as unknown as Message;

const mockChannel = {
  send: vi.fn(),
  threads: {
    create: vi.fn()
  }
} as unknown as TextChannel;

describe('MessageLimitHandler', () => {
  let handler: MessageLimitHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new MessageLimitHandler();
  });

  describe('Core functionality', () => {
    test('should not process content under limit', async () => {
      const shortContent = 'Hello world!';
      const result = await handler.handle(shortContent, mockChannel);
      
      expect(result.handled).toBe(false);
      expect(result.originalContent).toBe(shortContent);
    });

    test('should process content over limit', async () => {
      const longContent = 'x'.repeat(DISCORD_EMBED_DESC_LIMIT + 100);
      const result = await handler.handle(longContent, mockChannel);
      
      expect(result.handled).toBe(true);
      expect(result.method).toBeDefined();
    });

    test('should respect preferred method configuration', async () => {
      const longContent = 'x'.repeat(DISCORD_EMBED_DESC_LIMIT + 100);
      handler.setPreferredMethod('thread');
      
      const result = await handler.handle(longContent, mockChannel);
      expect(result.method).toBe('thread');
    });
  });

  describe('Error handling', () => {
    test('should handle Discord API errors gracefully', async () => {
      const error = new Error('Invalid Form Body');
      mockChannel.send.mockRejectedValueOnce(error);
      
      const content = 'x'.repeat(DISCORD_EMBED_DESC_LIMIT + 100);
      const result = await handler.handle(content, mockChannel, { fallback: true });
      
      expect(result.handled).toBe(true);
      expect(result.error).toBeUndefined();
    });

    test('should intercept embed description errors', () => {
      const longContent = 'x'.repeat(DISCORD_EMBED_DESC_LIMIT + 100);
      
      expect(() => {
        handler.validateEmbedContent({
          description: longContent,
          title: 'Test'
        });
      }).toThrow('Embed description exceeds limit');
    });
  });
});

describe('ContentAnalyzer', () => {
  let analyzer: ContentAnalyzer;

  beforeEach(() => {
    analyzer = new ContentAnalyzer();
  });

  test('should detect content type correctly', () => {
    expect(analyzer.detectContentType('```js\ncode\n```')).toBe('code');
    expect(analyzer.detectContentType('diff --git a/file.js')).toBe('diff');
    expect(analyzer.detectContentType('Regular text')).toBe('text');
    expect(analyzer.detectContentType('{"key": "value"}')).toBe('json');
  });

  test('should calculate size accurately', () => {
    const content = 'Hello 世界'; // Mixed ASCII and Unicode
    const size = analyzer.calculateSize(content);
    expect(size).toBeGreaterThan(0);
  });

  test('should identify if content needs handling', () => {
    const shortContent = 'Short';
    const longContent = 'x'.repeat(DISCORD_EMBED_DESC_LIMIT + 1);
    
    expect(analyzer.needsHandling(shortContent)).toBe(false);
    expect(analyzer.needsHandling(longContent)).toBe(true);
  });

  test('should extract metadata from different content types', () => {
    const codeContent = '```javascript\nfunction test() {\n  return true;\n}\n```';
    const metadata = analyzer.extractMetadata(codeContent);
    
    expect(metadata.type).toBe('code');
    expect(metadata.language).toBe('javascript');
    expect(metadata.lineCount).toBe(5);
  });
});

describe('SmartSummarizer', () => {
  let summarizer: SmartSummarizer;

  beforeEach(() => {
    summarizer = new SmartSummarizer();
  });

  test('should summarize code content', () => {
    const code = `
import React from 'react';
import { useState } from 'react';

// This is a very long component with many lines
${'// Comment line\n'.repeat(200)}

export default function Component() {
  const [state, setState] = useState(0);
  return <div>Hello</div>;
}`;

    const summary = summarizer.summarizeCode(code);
    
    expect(summary.content).toContain('import React');
    expect(summary.content).toContain('export default function Component');
    expect(summary.stats.imports).toBe(2);
    expect(summary.stats.exports).toBe(1);
    expect(summary.content.length).toBeLessThan(DISCORD_EMBED_DESC_LIMIT);
  });

  test('should summarize diff content', () => {
    const diff = `diff --git a/src/file1.js b/src/file1.js
index abc123..def456 100644
--- a/src/file1.js
+++ b/src/file1.js
@@ -1,10 +1,15 @@
-old line 1
+new line 1
+${'added line\n'.repeat(100)}
-${'removed line\n'.repeat(50)}`;

    const summary = summarizer.summarizeDiff(diff);
    
    expect(summary.content).toContain('src/file1.js');
    expect(summary.stats.filesChanged).toBe(1);
    expect(summary.stats.additions).toBeGreaterThan(0);
    expect(summary.stats.deletions).toBeGreaterThan(0);
  });

  test('should summarize text content', () => {
    const longText = `This is the first paragraph with important information.

${'This is a filler paragraph. '.repeat(500)}

This paragraph contains KEY_INFORMATION that should be preserved.

${'Another filler paragraph. '.repeat(500)}

Error: This is an important error message that should be included.`;

    const summary = summarizer.summarizeText(longText);
    
    expect(summary.content).toContain('first paragraph');
    expect(summary.content).toContain('KEY_INFORMATION');
    expect(summary.content).toContain('Error:');
    expect(summary.content.length).toBeLessThan(DISCORD_EMBED_DESC_LIMIT);
  });

  test('should generate accurate statistics', () => {
    const content = 'Line 1\nLine 2\nLine 3';
    const stats = summarizer.generateStats(content);
    
    expect(stats.totalLines).toBe(3);
    expect(stats.totalChars).toBe(content.length);
  });
});

describe('ThreadManager', () => {
  let threadManager: ThreadManager;
  const mockThread = {
    send: vi.fn(),
    setArchived: vi.fn()
  } as unknown as ThreadChannel;

  beforeEach(() => {
    vi.clearAllMocks();
    threadManager = new ThreadManager();
    (mockChannel.threads.create as any).mockResolvedValue(mockThread);
  });

  test('should create thread for overflow content', async () => {
    const longContent = 'x'.repeat(DISCORD_EMBED_DESC_LIMIT * 3);
    const result = await threadManager.createThread(mockChannel, 'Test Thread', longContent);
    
    expect(mockChannel.threads.create).toHaveBeenCalledWith({
      name: 'Test Thread',
      autoArchiveDuration: 60,
      reason: 'Content overflow from main channel'
    });
    expect(result.thread).toBe(mockThread);
  });

  test('should post content to thread in chunks', async () => {
    const longContent = 'x'.repeat(DISCORD_EMBED_DESC_LIMIT * 2.5);
    await threadManager.postToThread(mockThread, longContent);
    
    // Should split into 3 messages
    expect(mockThread.send).toHaveBeenCalledTimes(3);
  });

  test('should link thread in main channel', async () => {
    const summary = 'Summary of content';
    await threadManager.linkToMainChannel(mockChannel, mockThread, summary);
    
    expect(mockChannel.send).toHaveBeenCalled();
    const call = (mockChannel.send as any).mock.calls[0][0];
    expect(call.embeds[0].description).toContain(summary);
    expect(call.embeds[0].description).toContain('<#'); // Thread link
  });
});

describe('PaginationManager', () => {
  let paginationManager: PaginationManager;

  beforeEach(() => {
    vi.clearAllMocks();
    paginationManager = new PaginationManager();
  });

  test('should split content into pages', () => {
    const longContent = 'x'.repeat(DISCORD_EMBED_DESC_LIMIT * 2.5);
    const pages = paginationManager.splitContent(longContent);
    
    expect(pages.length).toBe(3);
    pages.forEach(page => {
      expect(page.length).toBeLessThanOrEqual(DISCORD_EMBED_DESC_LIMIT);
    });
  });

  test('should respect code block boundaries', () => {
    const content = `Text before
\`\`\`javascript
${'// Long code\n'.repeat(1000)}
\`\`\`
Text after`;
    
    const pages = paginationManager.splitContent(content, { respectCodeBlocks: true });
    
    // Verify code blocks aren't split mid-block
    pages.forEach(page => {
      const codeBlockCount = (page.match(/```/g) || []).length;
      expect(codeBlockCount % 2).toBe(0); // Even number = properly closed
    });
  });

  test('should create paginated message with navigation', async () => {
    const pages = ['Page 1 content', 'Page 2 content', 'Page 3 content'];
    const message = await paginationManager.createPaginatedMessage(mockChannel, pages);
    
    expect(mockChannel.send).toHaveBeenCalled();
    const sentMessage = (mockChannel.send as any).mock.calls[0][0];
    
    expect(sentMessage.embeds[0].footer.text).toContain('Page 1 of 3');
    expect(sentMessage.components).toBeDefined();
    expect(sentMessage.components[0].components).toHaveLength(2); // ⬅️ ➡️ buttons
  });

  test('should handle navigation interactions', async () => {
    const pages = ['Page 1', 'Page 2', 'Page 3'];
    paginationManager.pages.set('test-id', { 
      pages, 
      currentPage: 0,
      messageId: 'test-id'
    });
    
    // Simulate next page
    const updated = await paginationManager.handleNavigation('test-id', 'next');
    expect(updated.currentPage).toBe(1);
    
    // Simulate previous at boundary
    paginationManager.pages.get('test-id')!.currentPage = 0;
    const boundaryUpdate = await paginationManager.handleNavigation('test-id', 'previous');
    expect(boundaryUpdate.currentPage).toBe(0); // Should stay at 0
  });
});

describe('Integration Tests', () => {
  test('should handle real-world Claude Code output', async () => {
    const handler = new MessageLimitHandler();
    
    // Simulate a large Write tool call
    const largeFileContent = `
${'import statements\n'.repeat(50)}

${'function implementation() {\n  // code here\n}\n'.repeat(100)}

${'// More code\n'.repeat(200)}
`;
    
    const toolCallContent = `⏳ 🔧 Write (file_path=/test/file.js, content="${largeFileContent}")`;
    
    const result = await handler.handle(toolCallContent, mockChannel);
    
    expect(result.handled).toBe(true);
    expect(result.method).toBeDefined();
    
    // Verify the summary includes key information
    if (result.method === 'summary') {
      expect(result.summary).toBeDefined();
      expect(result.summary!.content).toContain('/test/file.js');
      expect(result.summary!.stats).toBeDefined();
    }
  });

  test('should maintain backward compatibility', async () => {
    const handler = new MessageLimitHandler();
    
    // Test various message types that should pass through unchanged
    const testCases = [
      '✅ Tests passed!',
      '💬 Claude: Simple response',
      '🔧 Edit: Small change',
      'Regular user message'
    ];
    
    for (const content of testCases) {
      const result = await handler.handle(content, mockChannel);
      expect(result.handled).toBe(false);
      expect(result.originalContent).toBe(content);
    }
  });
});