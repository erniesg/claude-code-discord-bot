import { ContentMetadata } from './content-analyzer';

export interface SummaryResult {
  content: string;
  stats: Record<string, any>;
  preservedElements: string[];
}

export class SmartSummarizer {
  private readonly MAX_SUMMARY_LENGTH = 3500; // Leave room for formatting
  
  async summarize(content: string, metadata: ContentMetadata): Promise<SummaryResult> {
    switch (metadata.type) {
      case 'code':
        return this.summarizeCode(content);
      case 'diff':
        return this.summarizeDiff(content);
      case 'json':
        return this.summarizeJson(content);
      case 'text':
        return this.summarizeText(content);
      case 'mixed':
        return this.summarizeMixed(content);
      default:
        return this.summarizeText(content);
    }
  }

  summarizeCode(content: string): SummaryResult {
    const stats = {
      totalLines: content.split('\n').length,
      totalChars: content.length,
      imports: 0,
      exports: 0,
      functions: 0,
      classes: 0,
      codeBlocks: (content.match(/```/g) || []).length / 2
    };

    const preservedElements: string[] = [];
    const summaryParts: string[] = [];

    // Extract and count imports
    const imports = content.match(/^import .+ from .+$/gm) || [];
    stats.imports = imports.length;
    if (imports.length > 0) {
      summaryParts.push('**Imports:**');
      summaryParts.push('```javascript');
      summaryParts.push(...imports.slice(0, 5));
      if (imports.length > 5) {
        summaryParts.push(`// ... and ${imports.length - 5} more imports`);
      }
      summaryParts.push('```');
      preservedElements.push(...imports.slice(0, 3));
    }

    // Extract and count exports
    const exports = content.match(/^export (default |async |)?(function|class|const|let|var) [\w]+/gm) || [];
    stats.exports = exports.length;
    if (exports.length > 0) {
      summaryParts.push('\n**Exports:**');
      summaryParts.push('```javascript');
      summaryParts.push(...exports.slice(0, 5));
      if (exports.length > 5) {
        summaryParts.push(`// ... and ${exports.length - 5} more exports`);
      }
      summaryParts.push('```');
      preservedElements.push(...exports.slice(0, 3));
    }

    // Extract main functions and classes
    const functions = content.match(/^(export |async |)function [\w]+/gm) || [];
    const classes = content.match(/^(export |)class [\w]+/gm) || [];
    stats.functions = functions.length;
    stats.classes = classes.length;

    if (functions.length > 0 || classes.length > 0) {
      summaryParts.push('\n**Main Components:**');
      summaryParts.push('```javascript');
      
      const mainComponents = [...functions.slice(0, 3), ...classes.slice(0, 3)];
      for (const component of mainComponents) {
        // Try to get the full signature
        const componentIndex = content.indexOf(component);
        if (componentIndex !== -1) {
          const nextBrace = content.indexOf('{', componentIndex);
          const signature = content.substring(componentIndex, nextBrace + 1).trim();
          summaryParts.push(signature + ' ... }');
        }
      }
      
      summaryParts.push('```');
    }

    // Add key patterns or notable elements
    const patterns = {
      'React Components': /^(function|const) \w+\s*=?\s*\(.*\)\s*=>\s*[\(<]/gm,
      'Async Operations': /async|await|Promise|\.then\(|\.catch\(/g,
      'API Calls': /fetch\(|axios\.|request\(/g,
      'Error Handling': /try\s*{|catch\s*\(|throw new/g
    };

    const detectedPatterns: string[] = [];
    for (const [name, pattern] of Object.entries(patterns)) {
      if (pattern.test(content)) {
        detectedPatterns.push(name);
      }
    }

    if (detectedPatterns.length > 0) {
      summaryParts.push('\n**Detected Patterns:**');
      summaryParts.push(detectedPatterns.map(p => `• ${p}`).join('\n'));
    }

    // Ensure we don't exceed the limit
    let summary = summaryParts.join('\n');
    if (summary.length > this.MAX_SUMMARY_LENGTH) {
      summary = summary.substring(0, this.MAX_SUMMARY_LENGTH - 50) + '\n\n... (content truncated)';
    }

    return {
      content: summary,
      stats,
      preservedElements
    };
  }

  summarizeDiff(content: string): SummaryResult {
    const stats = {
      filesChanged: 0,
      additions: 0,
      deletions: 0,
      totalLines: content.split('\n').length
    };

    const preservedElements: string[] = [];
    const summaryParts: string[] = [];

    // Extract file changes
    const files = content.match(/^diff --git a\/(.+) b\/(.+)$/gm) || [];
    stats.filesChanged = files.length;

    summaryParts.push('**Changed Files:**');
    const fileList = files.map(f => {
      const match = f.match(/a\/(.+) b\//);
      return match ? `• ${match[1]}` : '';
    }).filter(Boolean);

    summaryParts.push(...fileList.slice(0, 10));
    if (fileList.length > 10) {
      summaryParts.push(`• ... and ${fileList.length - 10} more files`);
    }

    // Count additions and deletions
    const additions = content.match(/^\+[^+]/gm) || [];
    const deletions = content.match(/^-[^-]/gm) || [];
    stats.additions = additions.length;
    stats.deletions = deletions.length;

    summaryParts.push(`\n**Summary:** ${stats.additions} additions, ${stats.deletions} deletions across ${stats.filesChanged} files`);

    // Extract key changes
    const hunks = content.match(/@@ .+ @@[\s\S]*?(?=@@|diff --git|$)/g) || [];
    
    if (hunks.length > 0) {
      summaryParts.push('\n**Key Changes:**');
      summaryParts.push('```diff');
      
      // Show first few hunks
      for (const hunk of hunks.slice(0, 3)) {
        const lines = hunk.split('\n').slice(0, 10);
        summaryParts.push(...lines);
        if (hunk.split('\n').length > 10) {
          summaryParts.push('...');
        }
      }
      
      summaryParts.push('```');
    }

    // Look for specific patterns in changes
    const patterns = {
      'New files': /^diff --git a\/dev\/null b\//gm,
      'Deleted files': /^diff --git a\/.+ b\/dev\/null$/gm,
      'Renamed files': /^rename from|^rename to/gm,
      'Binary files': /^Binary files? .+ differ$/gm
    };

    const detectedPatterns: string[] = [];
    for (const [name, pattern] of Object.entries(patterns)) {
      const matches = content.match(pattern);
      if (matches) {
        detectedPatterns.push(`${name}: ${matches.length}`);
      }
    }

    if (detectedPatterns.length > 0) {
      summaryParts.push('\n**Special Changes:**');
      summaryParts.push(detectedPatterns.map(p => `• ${p}`).join('\n'));
    }

    const summary = summaryParts.join('\n');
    return {
      content: summary.length > this.MAX_SUMMARY_LENGTH 
        ? summary.substring(0, this.MAX_SUMMARY_LENGTH - 50) + '\n\n... (diff truncated)'
        : summary,
      stats,
      preservedElements: fileList.slice(0, 5)
    };
  }

  summarizeJson(content: string): SummaryResult {
    const stats = {
      totalChars: content.length,
      depth: 0,
      keys: 0,
      arrays: 0,
      objects: 0
    };

    const preservedElements: string[] = [];
    const summaryParts: string[] = [];

    try {
      const parsed = JSON.parse(content);
      const structure = this.analyzeJsonStructure(parsed);
      
      stats.depth = structure.maxDepth;
      stats.keys = structure.totalKeys;
      stats.arrays = structure.arrays;
      stats.objects = structure.objects;

      summaryParts.push('**JSON Structure:**');
      summaryParts.push('```json');
      summaryParts.push(JSON.stringify(structure.skeleton, null, 2).substring(0, 1000));
      if (JSON.stringify(structure.skeleton).length > 1000) {
        summaryParts.push('// ... structure truncated');
      }
      summaryParts.push('```');

      summaryParts.push('\n**Top-level Keys:**');
      summaryParts.push(structure.topKeys.map(k => `• ${k}`).join('\n'));

      preservedElements.push(...structure.topKeys);

    } catch (e) {
      summaryParts.push('**Invalid JSON**');
      summaryParts.push('Failed to parse JSON content. Showing raw preview:');
      summaryParts.push('```');
      summaryParts.push(content.substring(0, 500) + '...');
      summaryParts.push('```');
    }

    const summary = summaryParts.join('\n');
    return {
      content: summary,
      stats,
      preservedElements
    };
  }

  summarizeText(content: string): SummaryResult {
    const stats = this.generateStats(content);
    const preservedElements: string[] = [];
    const summaryParts: string[] = [];

    // Extract first paragraph
    const paragraphs = content.split(/\n\n+/);
    if (paragraphs[0]) {
      summaryParts.push('**Beginning:**');
      summaryParts.push(paragraphs[0].substring(0, 500));
      if (paragraphs[0].length > 500) {
        summaryParts.push('...');
      }
    }

    // Extract key elements
    const keyPatterns = [
      { pattern: /^(ERROR|Error|FAILED|Failed): .+$/gm, label: 'Errors' },
      { pattern: /^(WARNING|Warning|WARN): .+$/gm, label: 'Warnings' },
      { pattern: /^#{1,3} .+$/gm, label: 'Headings' },
      { pattern: /https?:\/\/[^\s]+/g, label: 'URLs' },
      { pattern: /`[^`]+`/g, label: 'Code snippets' },
      { pattern: /\b[A-Z_]+=[^\s]+/g, label: 'Environment variables' }
    ];

    for (const { pattern, label } of keyPatterns) {
      const matches = content.match(pattern);
      if (matches && matches.length > 0) {
        summaryParts.push(`\n**${label}:**`);
        const unique = [...new Set(matches)];
        summaryParts.push(...unique.slice(0, 5).map(m => `• ${m.trim()}`));
        if (unique.length > 5) {
          summaryParts.push(`• ... and ${unique.length - 5} more`);
        }
        preservedElements.push(...unique.slice(0, 3));
      }
    }

    // Extract ending if different from beginning
    if (paragraphs.length > 1) {
      const lastParagraph = paragraphs[paragraphs.length - 1];
      if (lastParagraph && lastParagraph !== paragraphs[0]) {
        summaryParts.push('\n**Ending:**');
        summaryParts.push(lastParagraph.substring(0, 300));
        if (lastParagraph.length > 300) {
          summaryParts.push('...');
        }
      }
    }

    const summary = summaryParts.join('\n');
    return {
      content: summary.length > this.MAX_SUMMARY_LENGTH
        ? summary.substring(0, this.MAX_SUMMARY_LENGTH - 50) + '\n\n... (content truncated)'
        : summary,
      stats,
      preservedElements
    };
  }

  summarizeMixed(content: string): SummaryResult {
    // For mixed content, extract both code and text elements
    const codeBlocks = content.match(/```[\w]*\n[\s\S]*?\n```/g) || [];
    const textWithoutCode = content.replace(/```[\w]*\n[\s\S]*?\n```/g, '[CODE_BLOCK]');
    
    const stats = this.generateStats(content);
    stats.codeBlocks = codeBlocks.length;
    
    const summaryParts: string[] = [];
    const preservedElements: string[] = [];

    // Summarize text parts
    const textSummary = this.summarizeText(textWithoutCode);
    summaryParts.push(textSummary.content);

    // Add code block summary
    if (codeBlocks.length > 0) {
      summaryParts.push('\n**Code Blocks:**');
      for (let i = 0; i < Math.min(3, codeBlocks.length); i++) {
        const block = codeBlocks[i];
        const language = block.match(/```(\w+)/)?.[1] || 'code';
        const lines = block.split('\n');
        
        summaryParts.push(`\n*Block ${i + 1} (${language}, ${lines.length} lines):*`);
        summaryParts.push(lines.slice(0, 5).join('\n'));
        if (lines.length > 5) {
          summaryParts.push('...');
        }
      }
      
      if (codeBlocks.length > 3) {
        summaryParts.push(`\n... and ${codeBlocks.length - 3} more code blocks`);
      }
    }

    const summary = summaryParts.join('\n');
    return {
      content: summary.length > this.MAX_SUMMARY_LENGTH
        ? summary.substring(0, this.MAX_SUMMARY_LENGTH - 50) + '\n\n... (content truncated)'
        : summary,
      stats,
      preservedElements: [...preservedElements, ...textSummary.preservedElements]
    };
  }

  generateStats(content: string): Record<string, any> {
    const lines = content.split('\n');
    const words = content.split(/\s+/).filter(w => w.length > 0);
    
    return {
      totalLines: lines.length,
      totalChars: content.length,
      totalWords: words.length,
      avgLineLength: Math.round(content.length / lines.length),
      emptyLines: lines.filter(l => l.trim() === '').length
    };
  }

  private analyzeJsonStructure(obj: any, maxDepth: number = 5): any {
    const result = {
      skeleton: {} as any,
      topKeys: [] as string[],
      totalKeys: 0,
      arrays: 0,
      objects: 0,
      maxDepth: 0,
      currentDepth: 0
    };

    const analyze = (current: any, skeleton: any, depth: number): void => {
      if (depth > maxDepth) {
        return;
      }

      result.maxDepth = Math.max(result.maxDepth, depth);

      if (Array.isArray(current)) {
        result.arrays++;
        skeleton = `[Array of ${current.length} items]`;
        if (current.length > 0 && depth < maxDepth) {
          skeleton = [analyze(current[0], {}, depth + 1)];
        }
      } else if (current && typeof current === 'object') {
        result.objects++;
        const keys = Object.keys(current);
        result.totalKeys += keys.length;
        
        if (depth === 0) {
          result.topKeys = keys;
        }

        for (const key of keys.slice(0, 10)) {
          skeleton[key] = typeof current[key] === 'object' && depth < maxDepth
            ? analyze(current[key], {}, depth + 1)
            : `<${typeof current[key]}>`;
        }

        if (keys.length > 10) {
          skeleton['...'] = `${keys.length - 10} more keys`;
        }
      }

      return skeleton;
    };

    result.skeleton = analyze(obj, {}, 0);
    return result;
  }
}