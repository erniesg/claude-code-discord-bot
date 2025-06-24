import { 
  TextChannel, 
  ThreadChannel,
  Message,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  ComponentType
} from 'discord.js';
import { ContentAnalyzer } from './content-analyzer';

export interface PaginationOptions {
  respectCodeBlocks?: boolean;
  pageSize?: number;
  timeout?: number;
}

export interface PageState {
  pages: string[];
  currentPage: number;
  messageId: string;
  channelId: string;
  timestamp: number;
}

export class PaginationManager {
  private contentAnalyzer: ContentAnalyzer;
  private readonly DEFAULT_PAGE_SIZE = 4000; // Leave room for embed formatting
  private readonly INTERACTION_TIMEOUT = 300000; // 5 minutes
  public pages: Map<string, PageState>;

  constructor() {
    this.contentAnalyzer = new ContentAnalyzer();
    this.pages = new Map();
    
    // Clean up old page states periodically
    setInterval(() => this.cleanupOldPages(), 60000); // Every minute
  }

  splitContent(content: string, options: PaginationOptions = {}): string[] {
    const pageSize = options.pageSize || this.DEFAULT_PAGE_SIZE;
    const respectCodeBlocks = options.respectCodeBlocks ?? true;

    if (content.length <= pageSize) {
      return [content];
    }

    if (respectCodeBlocks && content.includes('```')) {
      return this.splitRespectingCodeBlocks(content, pageSize);
    }

    return this.splitAtNaturalBreaks(content, pageSize);
  }

  private splitRespectingCodeBlocks(content: string, pageSize: number): string[] {
    const pages: string[] = [];
    const codeBlockRegex = /```[\s\S]*?```/g;
    let lastIndex = 0;
    let currentPage = '';

    const matches = [...content.matchAll(codeBlockRegex)];

    for (const match of matches) {
      const beforeBlock = content.substring(lastIndex, match.index!);
      const codeBlock = match[0];
      
      // Add text before code block
      if (beforeBlock) {
        const beforeChunks = this.splitAtNaturalBreaks(beforeBlock, pageSize - currentPage.length);
        
        for (const chunk of beforeChunks) {
          if (currentPage.length + chunk.length > pageSize) {
            if (currentPage) pages.push(currentPage.trim());
            currentPage = chunk;
          } else {
            currentPage += chunk;
          }
        }
      }

      // Handle code block
      if (currentPage.length + codeBlock.length > pageSize) {
        // Push current page if not empty
        if (currentPage) pages.push(currentPage.trim());
        
        // If code block itself is too large, split it
        if (codeBlock.length > pageSize) {
          pages.push(...this.splitLargeCodeBlock(codeBlock, pageSize));
          currentPage = '';
        } else {
          currentPage = codeBlock;
        }
      } else {
        currentPage += (currentPage ? '\n' : '') + codeBlock;
      }

      lastIndex = match.index! + codeBlock.length;
    }

    // Handle remaining content
    const remaining = content.substring(lastIndex);
    if (remaining) {
      const remainingChunks = this.splitAtNaturalBreaks(remaining, pageSize - currentPage.length);
      
      for (const chunk of remainingChunks) {
        if (currentPage.length + chunk.length > pageSize) {
          if (currentPage) pages.push(currentPage.trim());
          currentPage = chunk;
        } else {
          currentPage += chunk;
        }
      }
    }

    if (currentPage) {
      pages.push(currentPage.trim());
    }

    return pages;
  }

  private splitAtNaturalBreaks(content: string, pageSize: number): string[] {
    if (content.length <= pageSize) {
      return [content];
    }

    const pages: string[] = [];
    let remaining = content;

    while (remaining.length > 0) {
      if (remaining.length <= pageSize) {
        pages.push(remaining);
        break;
      }

      // Find natural break point
      const breakPoint = this.contentAnalyzer.findNaturalBreakpoint(remaining, pageSize);
      const page = remaining.substring(0, breakPoint).trim();
      
      if (page) {
        pages.push(page);
        remaining = remaining.substring(breakPoint).trim();
      } else {
        // Fallback: force split at page size
        pages.push(remaining.substring(0, pageSize));
        remaining = remaining.substring(pageSize);
      }
    }

    return pages;
  }

  private splitLargeCodeBlock(codeBlock: string, pageSize: number): string[] {
    const lines = codeBlock.split('\n');
    const language = lines[0]; // e.g., "```javascript"
    const codeLines = lines.slice(1, -1); // Remove ``` markers
    const pages: string[] = [];
    let currentPage = language + '\n';

    for (let i = 0; i < codeLines.length; i++) {
      const line = codeLines[i];
      
      if (currentPage.length + line.length + 4 > pageSize) { // +4 for \n and closing ```
        pages.push(currentPage + '```');
        currentPage = language + '\n' + line + '\n';
      } else {
        currentPage += line + '\n';
      }
    }

    if (currentPage.length > language.length + 1) {
      pages.push(currentPage + '```');
    }

    return pages;
  }

  async createPaginatedMessage(
    channel: TextChannel | ThreadChannel,
    pages: string[],
    initialPage: number = 0
  ): Promise<Message> {
    const embed = this.createPageEmbed(pages, initialPage);
    const components = this.createNavigationButtons(initialPage, pages.length);

    const message = await channel.send({
      embeds: [embed],
      components: pages.length > 1 ? [components] : []
    });

    if (pages.length > 1) {
      // Store page state
      this.pages.set(message.id, {
        pages,
        currentPage: initialPage,
        messageId: message.id,
        channelId: channel.id,
        timestamp: Date.now()
      });

      // Set up interaction collector
      this.setupInteractionCollector(message, pages);
    }

    return message;
  }

  private createPageEmbed(pages: string[], pageIndex: number): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setDescription(pages[pageIndex])
      .setColor(0x3498db)
      .setTimestamp();

    if (pages.length > 1) {
      embed.setFooter({ text: `Page ${pageIndex + 1} of ${pages.length}` });
    }

    return embed;
  }

  private createNavigationButtons(currentPage: number, totalPages: number): ActionRowBuilder<ButtonBuilder> {
    const row = new ActionRowBuilder<ButtonBuilder>();

    const previousButton = new ButtonBuilder()
      .setCustomId('pagination_previous')
      .setLabel('◀️ Previous')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(currentPage === 0);

    const nextButton = new ButtonBuilder()
      .setCustomId('pagination_next')
      .setLabel('Next ▶️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(currentPage === totalPages - 1);

    row.addComponents(previousButton, nextButton);

    return row;
  }

  private setupInteractionCollector(message: Message, pages: string[]): void {
    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: this.INTERACTION_TIMEOUT
    });

    collector.on('collect', async (interaction: ButtonInteraction) => {
      const pageState = this.pages.get(message.id);
      if (!pageState) return;

      const direction = interaction.customId === 'pagination_next' ? 'next' : 'previous';
      const updatedState = await this.handleNavigation(message.id, direction);

      if (updatedState) {
        const embed = this.createPageEmbed(updatedState.pages, updatedState.currentPage);
        const components = this.createNavigationButtons(updatedState.currentPage, updatedState.pages.length);

        await interaction.update({
          embeds: [embed],
          components: [components]
        });
      }
    });

    collector.on('end', () => {
      // Remove buttons when collector expires
      this.pages.delete(message.id);
      message.edit({ components: [] }).catch(() => {});
    });
  }

  async handleNavigation(messageId: string, direction: 'next' | 'previous'): Promise<PageState | null> {
    const pageState = this.pages.get(messageId);
    if (!pageState) return null;

    const newPage = direction === 'next' 
      ? Math.min(pageState.currentPage + 1, pageState.pages.length - 1)
      : Math.max(pageState.currentPage - 1, 0);

    pageState.currentPage = newPage;
    return pageState;
  }

  private cleanupOldPages(): void {
    const now = Date.now();
    const maxAge = 600000; // 10 minutes

    for (const [messageId, state] of this.pages.entries()) {
      if (now - state.timestamp > maxAge) {
        this.pages.delete(messageId);
      }
    }
  }

  // Utility method to check if content should use pagination
  shouldUsePagination(content: string, metadata?: any): boolean {
    // Use pagination for medium-sized content
    if (content.length > 4096 && content.length < 10000) return true;
    
    // Use pagination for content with mixed types
    if (metadata?.type === 'mixed') return true;
    
    // Use pagination for JSON with structure
    if (metadata?.type === 'json' && metadata.stats?.depth > 3) return true;
    
    return false;
  }
}