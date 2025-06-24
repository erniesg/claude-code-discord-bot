import { 
  TextChannel, 
  ThreadChannel, 
  EmbedBuilder,
  ThreadAutoArchiveDuration 
} from 'discord.js';
import { ContentAnalyzer } from './content-analyzer';

export interface ThreadCreationResult {
  thread: ThreadChannel;
  messageCount: number;
}

export class ThreadManager {
  private contentAnalyzer: ContentAnalyzer;
  private readonly MAX_MESSAGE_LENGTH = 2000; // Discord message limit
  private readonly THREAD_ARCHIVE_DURATION: ThreadAutoArchiveDuration = 60; // 1 hour

  constructor() {
    this.contentAnalyzer = new ContentAnalyzer();
  }

  async createThread(
    channel: TextChannel, 
    name: string, 
    content: string
  ): Promise<ThreadCreationResult> {
    // Ensure thread name is within Discord's limit (100 chars)
    const threadName = name.length > 100 ? name.substring(0, 97) + '...' : name;

    // Create the thread
    const thread = await channel.threads.create({
      name: threadName,
      autoArchiveDuration: this.THREAD_ARCHIVE_DURATION,
      reason: 'Content overflow from main channel'
    });

    // Post content to thread
    const messageCount = await this.postToThread(thread, content);

    return {
      thread,
      messageCount
    };
  }

  async postToThread(thread: ThreadChannel, content: string): Promise<number> {
    const chunks = this.splitContentForThread(content);
    let messageCount = 0;

    // Post initial message explaining the thread
    await thread.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('📜 Full Content')
          .setDescription('This thread contains the complete content that exceeded Discord\'s embed limits.')
          .setColor(0x3498db)
          .setTimestamp()
      ]
    });
    messageCount++;

    // Post content chunks
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const isCodeBlock = chunk.trim().startsWith('```') && chunk.trim().endsWith('```');
      
      // For code blocks, send as-is to preserve formatting
      if (isCodeBlock || chunk.includes('```')) {
        await thread.send(chunk);
      } else {
        // For regular text, send in a code block to preserve formatting
        await thread.send(`\`\`\`\n${chunk}\n\`\`\``);
      }
      
      messageCount++;

      // Add a small delay to avoid rate limiting
      if (i < chunks.length - 1) {
        await this.delay(100);
      }
    }

    // Post completion message
    await thread.send({
      embeds: [
        new EmbedBuilder()
          .setDescription(`✅ **Content delivery complete**\n\nTotal messages: ${messageCount}`)
          .setColor(0x00ff00)
          .setFooter({ text: 'Thread will auto-archive after 1 hour of inactivity' })
      ]
    });

    return messageCount + 1;
  }

  async linkToMainChannel(
    channel: TextChannel,
    thread: ThreadChannel,
    summary: string
  ): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle('📎 Content Overflow Handled')
      .setDescription(summary)
      .addFields([
        {
          name: '🧵 Full Content',
          value: `View the complete content in <#${thread.id}>`,
          inline: false
        }
      ])
      .setColor(0x3498db)
      .setTimestamp()
      .setFooter({ text: 'Full content has been moved to a thread due to size limits' });

    await channel.send({ embeds: [embed] });
  }

  private splitContentForThread(content: string): string[] {
    const chunks: string[] = [];
    
    // First, try to split by code blocks to preserve them
    const codeBlockRegex = /```[\s\S]*?```/g;
    const codeBlocks = content.match(codeBlockRegex) || [];
    let remainingContent = content;
    
    // Process code blocks
    for (const block of codeBlocks) {
      const blockIndex = remainingContent.indexOf(block);
      
      // Add any content before this code block
      if (blockIndex > 0) {
        const beforeBlock = remainingContent.substring(0, blockIndex).trim();
        if (beforeBlock) {
          chunks.push(...this.splitPlainText(beforeBlock));
        }
      }
      
      // Add the code block (split if necessary)
      if (block.length > this.MAX_MESSAGE_LENGTH) {
        chunks.push(...this.splitCodeBlock(block));
      } else {
        chunks.push(block);
      }
      
      // Update remaining content
      remainingContent = remainingContent.substring(blockIndex + block.length);
    }
    
    // Add any remaining content
    if (remainingContent.trim()) {
      chunks.push(...this.splitPlainText(remainingContent.trim()));
    }
    
    return chunks.filter(chunk => chunk.trim().length > 0);
  }

  private splitPlainText(text: string): string[] {
    if (text.length <= this.MAX_MESSAGE_LENGTH) {
      return [text];
    }

    const chunks: string[] = [];
    const lines = text.split('\n');
    let currentChunk = '';

    for (const line of lines) {
      if (currentChunk.length + line.length + 1 > this.MAX_MESSAGE_LENGTH) {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
        }

        // If single line is too long, split by words
        if (line.length > this.MAX_MESSAGE_LENGTH) {
          const words = line.split(' ');
          let wordChunk = '';

          for (const word of words) {
            if (wordChunk.length + word.length + 1 > this.MAX_MESSAGE_LENGTH) {
              if (wordChunk) chunks.push(wordChunk.trim());
              wordChunk = word;
            } else {
              wordChunk += (wordChunk ? ' ' : '') + word;
            }
          }

          if (wordChunk) currentChunk = wordChunk;
        } else {
          currentChunk = line;
        }
      } else {
        currentChunk += (currentChunk ? '\n' : '') + line;
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }

  private splitCodeBlock(codeBlock: string): string[] {
    const chunks: string[] = [];
    const lines = codeBlock.split('\n');
    const language = lines[0]; // e.g., "```javascript"
    const codeLines = lines.slice(1, -1); // Remove ``` markers
    const maxLinesPerChunk = Math.floor((this.MAX_MESSAGE_LENGTH - 20) / 80); // Rough estimate

    for (let i = 0; i < codeLines.length; i += maxLinesPerChunk) {
      const chunkLines = codeLines.slice(i, i + maxLinesPerChunk);
      const chunk = `${language}\n${chunkLines.join('\n')}\n\`\`\``;
      chunks.push(chunk);
    }

    return chunks;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Utility method to check if content should use thread
  shouldUseThread(content: string, metadata?: any): boolean {
    // Use thread for very large content
    if (content.length > 10000) return true;
    
    // Use thread for content with many code blocks
    if (metadata?.codeBlockCount > 5) return true;
    
    // Use thread for diffs with many files
    if (metadata?.type === 'diff' && metadata.stats?.filesChanged > 10) return true;
    
    return false;
  }
}