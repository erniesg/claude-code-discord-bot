import { 
  TextChannel, 
  Message, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle,
  ThreadChannel 
} from 'discord.js';
import { ContentAnalyzer } from './content-analyzer';
import { SmartSummarizer } from './smart-summarizer';
import { ThreadManager } from './thread-manager';
import { PaginationManager } from './pagination-manager';

export type HandlingMethod = 'summary' | 'thread' | 'pagination' | 'none';

export interface HandlingOptions {
  preferredMethod?: HandlingMethod;
  fallback?: boolean;
  autoDetect?: boolean;
}

export interface HandlingResult {
  handled: boolean;
  method?: HandlingMethod;
  originalContent: string;
  processedContent?: string;
  summary?: {
    content: string;
    stats: Record<string, any>;
  };
  thread?: ThreadChannel;
  pages?: string[];
  error?: Error;
}

export interface EmbedContent {
  title?: string;
  description?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
}

export class MessageLimitHandler {
  private contentAnalyzer: ContentAnalyzer;
  private smartSummarizer: SmartSummarizer;
  private threadManager: ThreadManager;
  private paginationManager: PaginationManager;
  private preferredMethod: HandlingMethod = 'summary';

  constructor() {
    this.contentAnalyzer = new ContentAnalyzer();
    this.smartSummarizer = new SmartSummarizer();
    this.threadManager = new ThreadManager();
    this.paginationManager = new PaginationManager();
  }

  async handle(
    content: string, 
    channel: TextChannel | ThreadChannel,
    options: HandlingOptions = {}
  ): Promise<HandlingResult> {
    // Quick check if content needs handling
    if (!this.contentAnalyzer.needsHandling(content)) {
      return {
        handled: false,
        originalContent: content
      };
    }

    const method = options.preferredMethod || this.preferredMethod;
    const metadata = this.contentAnalyzer.extractMetadata(content);

    try {
      switch (method) {
        case 'summary':
          return await this.handleWithSummary(content, channel, metadata);
        
        case 'thread':
          return await this.handleWithThread(content, channel, metadata);
        
        case 'pagination':
          return await this.handleWithPagination(content, channel, metadata);
        
        default:
          return {
            handled: false,
            originalContent: content
          };
      }
    } catch (error) {
      console.error('Error handling message limit:', error);
      
      // If fallback is enabled, try a different method
      if (options.fallback && method !== 'summary') {
        return await this.handle(content, channel, { 
          ...options, 
          preferredMethod: 'summary', 
          fallback: false 
        });
      }
      
      return {
        handled: false,
        originalContent: content,
        error: error as Error
      };
    }
  }

  private async handleWithSummary(
    content: string, 
    channel: TextChannel | ThreadChannel,
    metadata: any
  ): Promise<HandlingResult> {
    const summary = await this.smartSummarizer.summarize(content, metadata);
    
    const embed = new EmbedBuilder()
      .setTitle('📝 Content Summary')
      .setDescription(summary.content)
      .setColor(0x3498db)
      .addFields([
        { 
          name: '📊 Statistics', 
          value: this.formatStats(summary.stats), 
          inline: true 
        }
      ])
      .setFooter({ text: 'Full content has been summarized due to Discord limits' });

    await channel.send({ embeds: [embed] });

    return {
      handled: true,
      method: 'summary',
      originalContent: content,
      processedContent: summary.content,
      summary
    };
  }

  private async handleWithThread(
    content: string,
    channel: TextChannel | ThreadChannel,
    metadata: any
  ): Promise<HandlingResult> {
    // Can't create thread in a thread
    if ('isThread' in channel && channel.isThread()) {
      return this.handleWithPagination(content, channel, metadata);
    }

    const threadName = this.generateThreadName(metadata);
    const result = await this.threadManager.createThread(
      channel as TextChannel, 
      threadName, 
      content
    );

    const summary = await this.smartSummarizer.summarize(content, metadata);
    await this.threadManager.linkToMainChannel(
      channel as TextChannel, 
      result.thread, 
      summary.content
    );

    return {
      handled: true,
      method: 'thread',
      originalContent: content,
      thread: result.thread,
      summary
    };
  }

  private async handleWithPagination(
    content: string,
    channel: TextChannel | ThreadChannel,
    metadata: any
  ): Promise<HandlingResult> {
    const pages = this.paginationManager.splitContent(content, {
      respectCodeBlocks: metadata.hasCodeBlocks
    });

    await this.paginationManager.createPaginatedMessage(channel, pages);

    return {
      handled: true,
      method: 'pagination',
      originalContent: content,
      pages
    };
  }

  validateEmbedContent(embed: EmbedContent): void {
    const limits = {
      title: 256,
      description: 4096,
      fieldName: 256,
      fieldValue: 1024,
      footer: 2048,
      total: 6000
    };

    if (embed.title && embed.title.length > limits.title) {
      throw new Error(`Embed title exceeds limit: ${embed.title.length}/${limits.title}`);
    }

    if (embed.description && embed.description.length > limits.description) {
      throw new Error(`Embed description exceeds limit: ${embed.description.length}/${limits.description}`);
    }

    if (embed.fields) {
      embed.fields.forEach((field, index) => {
        if (field.name.length > limits.fieldName) {
          throw new Error(`Field ${index} name exceeds limit: ${field.name.length}/${limits.fieldName}`);
        }
        if (field.value.length > limits.fieldValue) {
          throw new Error(`Field ${index} value exceeds limit: ${field.value.length}/${limits.fieldValue}`);
        }
      });
    }

    if (embed.footer?.text && embed.footer.text.length > limits.footer) {
      throw new Error(`Footer text exceeds limit: ${embed.footer.text.length}/${limits.footer}`);
    }

    // Calculate total character count
    let total = 0;
    if (embed.title) total += embed.title.length;
    if (embed.description) total += embed.description.length;
    if (embed.fields) {
      embed.fields.forEach(field => {
        total += field.name.length + field.value.length;
      });
    }
    if (embed.footer?.text) total += embed.footer.text.length;

    if (total > limits.total) {
      throw new Error(`Total embed size exceeds limit: ${total}/${limits.total}`);
    }
  }

  setPreferredMethod(method: HandlingMethod): void {
    this.preferredMethod = method;
  }

  private formatStats(stats: Record<string, any>): string {
    return Object.entries(stats)
      .map(([key, value]) => `${this.humanizeKey(key)}: ${value}`)
      .join('\n');
  }

  private humanizeKey(key: string): string {
    return key
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, str => str.toUpperCase())
      .trim();
  }

  private generateThreadName(metadata: any): string {
    const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const type = metadata.type;
    
    switch (type) {
      case 'code':
        return `Code ${metadata.language || 'snippet'} - ${timestamp}`;
      case 'diff':
        return `Changes - ${timestamp}`;
      case 'json':
        return `JSON Data - ${timestamp}`;
      default:
        return `Content - ${timestamp}`;
    }
  }

  // Utility method to safely create embeds
  async safeCreateEmbed(
    channel: TextChannel | ThreadChannel,
    embedData: {
      title?: string;
      description?: string;
      color?: number;
      fields?: Array<{ name: string; value: string; inline?: boolean }>;
      footer?: { text: string };
    }
  ): Promise<Message | null> {
    try {
      // Validate before creating
      this.validateEmbedContent(embedData);
      
      const embed = new EmbedBuilder();
      
      if (embedData.title) embed.setTitle(embedData.title);
      if (embedData.description) embed.setDescription(embedData.description);
      if (embedData.color) embed.setColor(embedData.color);
      if (embedData.fields) embed.addFields(embedData.fields);
      if (embedData.footer) embed.setFooter(embedData.footer);
      
      return await channel.send({ embeds: [embed] });
    } catch (error) {
      // If validation fails, handle with our handler
      if (embedData.description && this.contentAnalyzer.needsHandling(embedData.description)) {
        const result = await this.handle(embedData.description, channel);
        return null; // Content was handled separately
      }
      
      throw error;
    }
  }
}