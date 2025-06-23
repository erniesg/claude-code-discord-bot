import { 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  EmbedBuilder,
  ThreadAutoArchiveDuration 
} from 'discord.js';

export interface ToolSummary {
  toolName: string;
  operation: string;
  summary: string;
  details?: string;
  stats?: {
    linesAdded?: number;
    linesRemoved?: number;
    fileSize?: string;
    duration?: string;
  };
  hasFullContent: boolean;
}

export interface ContentViewOptions {
  enableThreadView: boolean;
  enablePagination: boolean;
  maxPreviewLength: number;
}

export class ContentSummarizer {
  private readonly DEFAULT_MAX_LENGTH = 3500; // Reserve space for Discord formatting
  private readonly THREAD_PREFIX = "📄 Full Content: ";
  
  constructor(private options: ContentViewOptions = {
    enableThreadView: true,
    enablePagination: true,
    maxPreviewLength: 3500
  }) {}

  /**
   * Generate smart summary for tool operations
   */
  generateToolSummary(toolName: string, input: any, result: string, isError: boolean = false): ToolSummary {
    const maxLength = this.options.maxPreviewLength;
    
    switch (toolName.toLowerCase()) {
      case 'write':
        return this.summarizeWriteOperation(input, result, isError, maxLength);
      case 'edit':
      case 'multiedit':
        return this.summarizeEditOperation(toolName, input, result, isError, maxLength);
      case 'read':
        return this.summarizeReadOperation(input, result, isError, maxLength);
      case 'bash':
        return this.summarizeBashOperation(input, result, isError, maxLength);
      case 'glob':
      case 'grep':
        return this.summarizeSearchOperation(toolName, input, result, isError, maxLength);
      default:
        return this.summarizeGenericOperation(toolName, input, result, isError, maxLength);
    }
  }

  private summarizeWriteOperation(input: any, result: string, isError: boolean, maxLength: number): ToolSummary {
    const filePath = input.file_path || 'unknown';
    const content = input.content || '';
    const fileName = filePath.split('/').pop() || 'file';
    
    const lines = content.split('\n').length;
    const sizeKB = Math.round(content.length / 1024 * 100) / 100;
    
    // Extract key features from content
    const features = this.extractCodeFeatures(content);
    
    const summary = `📄 Created ${fileName} (${lines} lines, ${sizeKB}KB)${features ? '\n' + features : ''}`;
    
    return {
      toolName: 'Write',
      operation: 'create',
      summary,
      details: content,
      stats: {
        linesAdded: lines,
        fileSize: `${sizeKB}KB`
      },
      hasFullContent: content.length > 500
    };
  }

  private summarizeEditOperation(toolName: string, input: any, result: string, isError: boolean, maxLength: number): ToolSummary {
    const filePath = input.file_path || 'unknown';
    const fileName = filePath.split('/').pop() || 'file';
    
    if (toolName === 'multiedit') {
      const edits = input.edits || [];
      const totalChanges = edits.length;
      
      const summary = `📝 Modified ${fileName} (${totalChanges} changes)`;
      const details = this.formatMultiEditDetails(edits, maxLength);
      
      return {
        toolName: 'MultiEdit',
        operation: 'modify',
        summary,
        details,
        stats: { linesAdded: totalChanges },
        hasFullContent: details.length > 500
      };
    } else {
      const oldString = input.old_string || '';
      const newString = input.new_string || '';
      
      const summary = `📝 Modified ${fileName}`;
      const details = this.formatEditDiff(oldString, newString, maxLength);
      
      return {
        toolName: 'Edit',
        operation: 'modify',
        summary,
        details,
        hasFullContent: (oldString + newString).length > 500
      };
    }
  }

  private summarizeReadOperation(input: any, result: string, isError: boolean, maxLength: number): ToolSummary {
    const filePath = input.file_path || 'unknown';
    const fileName = filePath.split('/').pop() || 'file';
    const lines = result.split('\n').length;
    
    const summary = `📖 Read ${fileName} (${lines} lines)`;
    const preview = this.truncateContent(result, Math.min(maxLength / 2, 1000));
    
    return {
      toolName: 'Read',
      operation: 'read',
      summary,
      details: result,
      stats: { fileSize: `${Math.round(result.length / 1024 * 100) / 100}KB` },
      hasFullContent: result.length > 1000
    };
  }

  private summarizeBashOperation(input: any, result: string, isError: boolean, maxLength: number): ToolSummary {
    const command = input.command || 'unknown';
    const description = input.description || '';
    
    const summary = `🔧 ${description || `Ran: ${command.substring(0, 50)}${command.length > 50 ? '...' : ''}`}`;
    const preview = this.truncateContent(result, Math.min(maxLength / 2, 800));
    
    return {
      toolName: 'Bash',
      operation: 'execute',
      summary,
      details: `Command: ${command}\n\nOutput:\n${result}`,
      hasFullContent: result.length > 800
    };
  }

  private summarizeSearchOperation(toolName: string, input: any, result: string, isError: boolean, maxLength: number): ToolSummary {
    const pattern = input.pattern || input.query || 'unknown';
    const matches = result.split('\n').filter(line => line.trim()).length;
    
    const summary = `🔍 ${toolName === 'glob' ? 'Found' : 'Searched'} "${pattern}" (${matches} ${matches === 1 ? 'match' : 'matches'})`;
    const preview = this.truncateContent(result, Math.min(maxLength / 2, 600));
    
    return {
      toolName: toolName === 'glob' ? 'Glob' : 'Grep',
      operation: 'search',
      summary,
      details: result,
      hasFullContent: result.length > 600
    };
  }

  private summarizeGenericOperation(toolName: string, input: any, result: string, isError: boolean, maxLength: number): ToolSummary {
    const inputStr = Object.keys(input).map(k => `${k}=${input[k]}`).join(', ');
    const summary = `🔧 ${toolName}${inputStr ? ` (${inputStr.substring(0, 100)}${inputStr.length > 100 ? '...' : ''})` : ''}`;
    
    return {
      toolName,
      operation: 'execute',
      summary,
      details: result,
      hasFullContent: result.length > 500
    };
  }

  /**
   * Extract key features from code content
   */
  private extractCodeFeatures(content: string): string {
    const features = [];
    
    // Detect classes
    const classMatches = content.match(/class\s+(\w+)/g);
    if (classMatches && classMatches.length > 0) {
      features.push(`✨ ${classMatches.length} class${classMatches.length > 1 ? 'es' : ''}`);
    }
    
    // Detect functions/methods
    const funcMatches = content.match(/def\s+(\w+)|function\s+(\w+)|async\s+function\s+(\w+)/g);
    if (funcMatches && funcMatches.length > 0) {
      features.push(`✨ ${funcMatches.length} function${funcMatches.length > 1 ? 's' : ''}`);
    }
    
    // Detect imports
    const importMatches = content.match(/^(import|from)\s+/gm);
    if (importMatches && importMatches.length > 0) {
      features.push(`📦 ${importMatches.length} import${importMatches.length > 1 ? 's' : ''}`);
    }
    
    return features.join(', ');
  }

  /**
   * Format diff for edit operations
   */
  private formatEditDiff(oldStr: string, newStr: string, maxLength: number): string {
    const diff = [];
    
    if (oldStr) {
      const oldLines = oldStr.split('\n');
      oldLines.slice(0, Math.min(oldLines.length, 10)).forEach(line => {
        diff.push(`- ${line}`);
      });
      if (oldLines.length > 10) {
        diff.push(`... [truncated ${oldLines.length - 10} lines]`);
      }
    }
    
    if (newStr) {
      const newLines = newStr.split('\n');
      newLines.slice(0, Math.min(newLines.length, 10)).forEach(line => {
        diff.push(`+ ${line}`);
      });
      if (newLines.length > 10) {
        diff.push(`... [truncated ${newLines.length - 10} lines]`);
      }
    }
    
    const diffStr = diff.join('\n');
    return this.truncateContent(diffStr, maxLength);
  }

  /**
   * Format multi-edit details
   */
  private formatMultiEditDetails(edits: any[], maxLength: number): string {
    const details = [];
    
    edits.slice(0, 5).forEach((edit, index) => {
      details.push(`**Change ${index + 1}:**`);
      details.push(`- ${edit.old_string.split('\n')[0].substring(0, 80)}${edit.old_string.length > 80 ? '...' : ''}`);
      details.push(`+ ${edit.new_string.split('\n')[0].substring(0, 80)}${edit.new_string.length > 80 ? '...' : ''}`);
      details.push('');
    });
    
    if (edits.length > 5) {
      details.push(`... [${edits.length - 5} more changes]`);
    }
    
    const detailStr = details.join('\n');
    return this.truncateContent(detailStr, maxLength);
  }

  /**
   * Truncate content to fit within limits
   */
  private truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) {
      return content;
    }
    
    return content.substring(0, maxLength - 3) + '...';
  }

  /**
   * Create action buttons for content viewing
   */
  createContentButtons(toolId: string, hasFullContent: boolean): ActionRowBuilder<ButtonBuilder> | null {
    if (!hasFullContent) return null;
    
    const buttons = new ActionRowBuilder<ButtonBuilder>();
    
    if (this.options.enableThreadView) {
      buttons.addComponents(
        new ButtonBuilder()
          .setCustomId(`thread_${toolId}`)
          .setLabel('View in Thread')
          .setEmoji('💬')
          .setStyle(ButtonStyle.Secondary)
      );
    }
    
    if (this.options.enablePagination) {
      buttons.addComponents(
        new ButtonBuilder()
          .setCustomId(`paginate_${toolId}`)
          .setLabel('View Pages')
          .setEmoji('📄')
          .setStyle(ButtonStyle.Primary)
      );
    }
    
    return buttons.components.length > 0 ? buttons : null;
  }

  /**
   * Create content thread
   */
  async createContentThread(
    channel: any, 
    toolSummary: ToolSummary, 
    toolId: string
  ): Promise<any> {
    if (!this.options.enableThreadView || !toolSummary.hasFullContent) {
      return null;
    }
    
    const threadName = `${this.THREAD_PREFIX}${toolSummary.toolName} - ${new Date().toLocaleTimeString()}`;
    
    try {
      const thread = await channel.threads.create({
        name: threadName,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
        reason: `Full content view for ${toolSummary.toolName} operation`
      });
      
      // Split content into chunks for thread
      await this.postContentToThread(thread, toolSummary);
      
      return thread;
    } catch (error) {
      console.error('Error creating thread:', error);
      return null;
    }
  }

  /**
   * Post content to thread in chunks
   */
  private async postContentToThread(thread: any, toolSummary: ToolSummary): Promise<void> {
    const content = toolSummary.details || 'No content available';
    const maxMessageLength = 1900; // Discord limit with some buffer
    
    // Send header
    const headerEmbed = new EmbedBuilder()
      .setTitle(`${toolSummary.toolName} - ${toolSummary.operation}`)
      .setDescription(toolSummary.summary)
      .setColor(0x0099FF)
      .setTimestamp();
      
    if (toolSummary.stats) {
      const statsText = Object.entries(toolSummary.stats)
        .filter(([_, value]) => value !== undefined)
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ');
      if (statsText) {
        headerEmbed.addFields({ name: 'Stats', value: statsText });
      }
    }
    
    await thread.send({ embeds: [headerEmbed] });
    
    // Send content in chunks
    if (content.length <= maxMessageLength) {
      await thread.send(`\`\`\`\n${content}\n\`\`\``);
    } else {
      const chunks = this.splitIntoChunks(content, maxMessageLength - 10); // Account for code block formatting
      
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const isFirst = i === 0;
        const isLast = i === chunks.length - 1;
        
        let formattedChunk = '';
        if (isFirst && isLast) {
          formattedChunk = `\`\`\`\n${chunk}\n\`\`\``;
        } else if (isFirst) {
          formattedChunk = `\`\`\`\n${chunk}`;
        } else if (isLast) {
          formattedChunk = `${chunk}\n\`\`\``;
        } else {
          formattedChunk = chunk;
        }
        
        await thread.send(formattedChunk);
        
        // Small delay to avoid rate limits
        if (i < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }
  }

  /**
   * Create paginated messages
   */
  async createPaginatedView(
    channel: any, 
    toolSummary: ToolSummary, 
    toolId: string
  ): Promise<any[]> {
    if (!this.options.enablePagination || !toolSummary.hasFullContent) {
      return [];
    }
    
    const content = toolSummary.details || 'No content available';
    const maxPageLength = 1800;
    const pages = this.splitIntoChunks(content, maxPageLength);
    const messages = [];
    
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const pageEmbed = new EmbedBuilder()
        .setTitle(`${toolSummary.toolName} - Page ${i + 1}/${pages.length}`)
        .setDescription(`\`\`\`\n${page}\n\`\`\``)
        .setColor(0x0099FF)
        .setFooter({ text: `${toolSummary.operation} | ${i + 1}/${pages.length}` });
      
      const navigationButtons = new ActionRowBuilder<ButtonBuilder>();
      
      if (i > 0) {
        navigationButtons.addComponents(
          new ButtonBuilder()
            .setCustomId(`prev_${toolId}_${i}`)
            .setLabel('◀️ Previous')
            .setStyle(ButtonStyle.Secondary)
        );
      }
      
      navigationButtons.addComponents(
        new ButtonBuilder()
          .setCustomId(`summary_${toolId}`)
          .setLabel('📄 Summary')
          .setStyle(ButtonStyle.Secondary)
      );
      
      if (i < pages.length - 1) {
        navigationButtons.addComponents(
          new ButtonBuilder()
            .setCustomId(`next_${toolId}_${i}`)
            .setLabel('Next ▶️')
            .setStyle(ButtonStyle.Secondary)
        );
      }
      
      const message = await channel.send({ 
        embeds: [pageEmbed],
        components: [navigationButtons]
      });
      
      messages.push(message);
      
      // Only send first page initially
      if (i === 0) break;
    }
    
    return messages;
  }

  /**
   * Split content into manageable chunks
   */
  private splitIntoChunks(content: string, maxLength: number): string[] {
    if (content.length <= maxLength) {
      return [content];
    }
    
    const chunks = [];
    let currentChunk = '';
    const lines = content.split('\n');
    
    for (const line of lines) {
      if (currentChunk.length + line.length + 1 > maxLength) {
        if (currentChunk) {
          chunks.push(currentChunk);
          currentChunk = '';
        }
        
        // If single line is too long, split it
        if (line.length > maxLength) {
          const lineChunks = this.splitLongLine(line, maxLength);
          chunks.push(...lineChunks.slice(0, -1));
          currentChunk = lineChunks[lineChunks.length - 1];
        } else {
          currentChunk = line;
        }
      } else {
        currentChunk += (currentChunk ? '\n' : '') + line;
      }
    }
    
    if (currentChunk) {
      chunks.push(currentChunk);
    }
    
    return chunks;
  }

  /**
   * Split a long line into chunks
   */
  private splitLongLine(line: string, maxLength: number): string[] {
    const chunks = [];
    for (let i = 0; i < line.length; i += maxLength) {
      chunks.push(line.substring(i, i + maxLength));
    }
    return chunks;
  }
}