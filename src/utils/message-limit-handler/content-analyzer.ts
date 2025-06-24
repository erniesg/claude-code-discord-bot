export interface ContentMetadata {
  type: 'code' | 'diff' | 'json' | 'text' | 'mixed';
  language?: string;
  lineCount: number;
  charCount: number;
  hasCodeBlocks: boolean;
  codeBlockCount: number;
  keyElements: string[];
  estimatedTokens: number;
}

export class ContentAnalyzer {
  private readonly DISCORD_EMBED_DESC_LIMIT = 4096;
  private readonly DISCORD_EMBED_TITLE_LIMIT = 256;
  private readonly DISCORD_EMBED_TOTAL_LIMIT = 6000;

  detectContentType(content: string): ContentMetadata['type'] {
    // Check for code blocks first
    if (/```[\w]*\n[\s\S]*?\n```/.test(content)) {
      return 'code';
    }
    
    // Check for diff format
    if (/^diff --git|^---|\+\+\+|^@@/m.test(content)) {
      return 'diff';
    }
    
    // Check for JSON
    try {
      const trimmed = content.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || 
          (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        JSON.parse(trimmed);
        return 'json';
      }
    } catch {
      // Not valid JSON
    }
    
    // Check for mixed content (has both code and text)
    const hasCode = /^(import|export|function|class|const|let|var)\s/m.test(content);
    const hasText = /^[A-Z][^.!?]*[.!?]\s/m.test(content);
    
    if (hasCode && hasText) {
      return 'mixed';
    } else if (hasCode) {
      return 'code';
    }
    
    return 'text';
  }

  calculateSize(content: string): number {
    // Calculate byte size for accurate Discord limit checking
    return new TextEncoder().encode(content).length;
  }

  needsHandling(content: string, limitOverride?: number): boolean {
    const limit = limitOverride || this.DISCORD_EMBED_DESC_LIMIT;
    return content.length > limit;
  }

  extractMetadata(content: string): ContentMetadata {
    const lines = content.split('\n');
    const type = this.detectContentType(content);
    const codeBlocks = content.match(/```[\w]*\n[\s\S]*?\n```/g) || [];
    
    // Extract language from first code block if present
    let language: string | undefined;
    if (codeBlocks.length > 0) {
      const match = codeBlocks[0].match(/```(\w+)/);
      language = match?.[1];
    }
    
    // Extract key elements based on content type
    const keyElements = this.extractKeyElements(content, type);
    
    // Estimate tokens (rough approximation)
    const estimatedTokens = Math.ceil(content.length / 4);
    
    return {
      type,
      language,
      lineCount: lines.length,
      charCount: content.length,
      hasCodeBlocks: codeBlocks.length > 0,
      codeBlockCount: codeBlocks.length,
      keyElements,
      estimatedTokens
    };
  }

  private extractKeyElements(content: string, type: ContentMetadata['type']): string[] {
    const elements: string[] = [];
    
    switch (type) {
      case 'code':
        // Extract imports, exports, function names, class names
        const imports = content.match(/^import .+ from .+$/gm) || [];
        const exports = content.match(/^export (default |async |)?(function|class|const|let|var) \w+/gm) || [];
        const functions = content.match(/^(async |)function \w+/gm) || [];
        const classes = content.match(/^class \w+/gm) || [];
        
        elements.push(...imports.slice(0, 3));
        elements.push(...exports.slice(0, 3));
        elements.push(...functions.slice(0, 3));
        elements.push(...classes.slice(0, 3));
        break;
        
      case 'diff':
        // Extract file paths and summary stats
        const files = content.match(/^diff --git a\/.+ b\/.+$/gm) || [];
        const additions = (content.match(/^\+[^+]/gm) || []).length;
        const deletions = (content.match(/^-[^-]/gm) || []).length;
        
        elements.push(...files.map(f => f.replace(/^diff --git a\/(.+) b\/.+$/, '$1')));
        elements.push(`+${additions} -${deletions}`);
        break;
        
      case 'json':
        // Extract top-level keys
        try {
          const parsed = JSON.parse(content);
          if (typeof parsed === 'object' && parsed !== null) {
            elements.push(...Object.keys(parsed).slice(0, 5));
          }
        } catch {
          // Invalid JSON
        }
        break;
        
      case 'text':
      case 'mixed':
        // Extract headings, errors, warnings, file paths
        const headings = content.match(/^#{1,3} .+$/gm) || [];
        const errors = content.match(/^(Error|ERROR|Failed|FAILED): .+$/gm) || [];
        const warnings = content.match(/^(Warning|WARN|Caution): .+$/gm) || [];
        const filePaths = content.match(/(?:\/[\w.-]+)+\.\w+/g) || [];
        
        elements.push(...headings.slice(0, 3));
        elements.push(...errors);
        elements.push(...warnings);
        elements.push(...[...new Set(filePaths)].slice(0, 5));
        break;
    }
    
    return [...new Set(elements)]; // Remove duplicates
  }

  splitIntoChunks(content: string, maxSize: number = this.DISCORD_EMBED_DESC_LIMIT): string[] {
    if (content.length <= maxSize) {
      return [content];
    }
    
    const chunks: string[] = [];
    const lines = content.split('\n');
    let currentChunk = '';
    
    for (const line of lines) {
      // If adding this line would exceed the limit
      if (currentChunk.length + line.length + 1 > maxSize) {
        // If current chunk is not empty, save it
        if (currentChunk) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
        }
        
        // If single line is too long, split it
        if (line.length > maxSize) {
          const words = line.split(' ');
          let wordChunk = '';
          
          for (const word of words) {
            if (wordChunk.length + word.length + 1 > maxSize) {
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
    
    // Don't forget the last chunk
    if (currentChunk) {
      chunks.push(currentChunk.trim());
    }
    
    return chunks;
  }

  findNaturalBreakpoint(content: string, targetPosition: number, windowSize: number = 200): number {
    const start = Math.max(0, targetPosition - windowSize);
    const end = Math.min(content.length, targetPosition + windowSize);
    const searchWindow = content.substring(start, end);
    
    // Priority order for breakpoints
    const breakpoints = [
      { pattern: /\n\n/, priority: 1 },        // Paragraph break
      { pattern: /\n```\n/, priority: 2 },     // Code block end
      { pattern: /\n```\w*\n/, priority: 2 },  // Code block start
      { pattern: /\.\s/, priority: 3 },        // Sentence end
      { pattern: /\n/, priority: 4 },          // Line break
      { pattern: /\s/, priority: 5 }           // Word break
    ];
    
    let bestBreak = targetPosition;
    let bestPriority = 999;
    
    for (const { pattern, priority } of breakpoints) {
      const matches = [...searchWindow.matchAll(new RegExp(pattern, 'g'))];
      
      for (const match of matches) {
        const absolutePosition = start + match.index! + match[0].length;
        const distance = Math.abs(absolutePosition - targetPosition);
        
        // Prefer breaks closer to target position with higher priority
        if (priority < bestPriority || (priority === bestPriority && distance < Math.abs(bestBreak - targetPosition))) {
          bestBreak = absolutePosition;
          bestPriority = priority;
        }
      }
    }
    
    return bestBreak;
  }
}