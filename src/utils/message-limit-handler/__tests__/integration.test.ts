import { describe, test, expect } from 'vitest';
import { MessageLimitHandler } from '../message-limit-handler';
import { ContentAnalyzer } from '../content-analyzer';
import { SmartSummarizer } from '../smart-summarizer';

describe('Message Limit Handler Integration', () => {
  test('should create handler without errors', () => {
    const handler = new MessageLimitHandler();
    expect(handler).toBeDefined();
  });

  test('should analyze content correctly', () => {
    const analyzer = new ContentAnalyzer();
    
    const codeContent = '```javascript\nfunction test() {\n  return true;\n}\n```';
    const metadata = analyzer.extractMetadata(codeContent);
    
    expect(metadata.type).toBe('code');
    expect(metadata.hasCodeBlocks).toBe(true);
  });

  test('should detect when content needs handling', () => {
    const analyzer = new ContentAnalyzer();
    
    const shortContent = 'Hello world';
    const longContent = 'x'.repeat(5000);
    
    expect(analyzer.needsHandling(shortContent)).toBe(false);
    expect(analyzer.needsHandling(longContent)).toBe(true);
  });

  test('should summarize code content', () => {
    const summarizer = new SmartSummarizer();
    
    const codeContent = `
import React from 'react';
function MyComponent() {
  const [state, setState] = useState(0);
  return <div>Hello</div>;
}
export default MyComponent;
`;
    
    const summary = summarizer.summarizeCode(codeContent);
    
    expect(summary.content).toContain('import React');
    expect(summary.content).toContain('MyComponent');
    expect(summary.stats.imports).toBe(1);
    expect(summary.stats.functions).toBe(1);
  });

  test('should validate embed content limits', () => {
    const handler = new MessageLimitHandler();
    
    const validEmbed = {
      title: 'Test',
      description: 'Short description'
    };
    
    const invalidEmbed = {
      title: 'Test',
      description: 'x'.repeat(5000)
    };
    
    expect(() => handler.validateEmbedContent(validEmbed)).not.toThrow();
    expect(() => handler.validateEmbedContent(invalidEmbed)).toThrow();
  });

  test('should split content into chunks', () => {
    const analyzer = new ContentAnalyzer();
    
    const longText = 'word '.repeat(2000);
    const chunks = analyzer.splitIntoChunks(longText, 1000);
    
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach(chunk => {
      expect(chunk.length).toBeLessThanOrEqual(1000);
    });
  });
});