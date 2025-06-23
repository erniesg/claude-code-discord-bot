import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { EmbedBuilder } from "discord.js";
import type { SDKMessage } from "../types/index.js";
import { buildClaudeCommand, type DiscordContext } from "../utils/shell.js";
import { DatabaseManager } from "../db/database.js";
import { ContentSummarizer } from "../utils/content-summarizer.js";

export class ClaudeManager {
  private db: DatabaseManager;
  private channelMessages = new Map<string, any>();
  private channelToolCalls = new Map<string, Map<string, { message: any, toolId: string, toolName: string, input: any }>>();
  private channelNames = new Map<string, string>();
  private channelProcesses = new Map<
    string,
    {
      process: any;
      sessionId?: string;
      discordMessage: any;
    }
  >();
  private channelMappings: Record<string, string> = {};
  private contentSummarizer: ContentSummarizer;
  private toolSummaries = new Map<string, Map<string, any>>(); // channelId -> toolId -> summary
  private jsonBuffers = new Map<string, string>(); // channelId -> incomplete JSON buffer

  constructor(private baseFolder: string) {
    this.db = new DatabaseManager();
    this.contentSummarizer = new ContentSummarizer();
    // Clean up old sessions on startup
    this.db.cleanupOldSessions();
    // Load channel mappings
    this.loadChannelMappings();
  }

  hasActiveProcess(channelId: string): boolean {
    return this.channelProcesses.has(channelId);
  }

  killActiveProcess(channelId: string): void {
    const activeProcess = this.channelProcesses.get(channelId);
    if (activeProcess?.process) {
      console.log(`Killing active process for channel ${channelId}`);
      activeProcess.process.kill("SIGTERM");
    }
  }

  clearSession(channelId: string): void {
    this.killActiveProcess(channelId);
    this.db.clearSession(channelId);
    this.channelMessages.delete(channelId);
    this.channelToolCalls.delete(channelId);
    this.channelNames.delete(channelId);
    this.channelProcesses.delete(channelId);
    this.toolSummaries.delete(channelId);
    this.jsonBuffers.delete(channelId);
  }

  setDiscordMessage(channelId: string, message: any): void {
    this.channelMessages.set(channelId, message);
    this.channelToolCalls.set(channelId, new Map());
  }

  reserveChannel(
    channelId: string,
    sessionId: string | undefined,
    discordMessage: any
  ): void {
    // Kill any existing process (safety measure)
    const existingProcess = this.channelProcesses.get(channelId);
    if (existingProcess?.process) {
      console.log(
        `Killing existing process for channel ${channelId} before starting new one`
      );
      existingProcess.process.kill("SIGTERM");
    }

    // Reserve the channel by adding a placeholder entry (prevents race conditions)
    this.channelProcesses.set(channelId, {
      process: null, // Will be set when process actually starts
      sessionId,
      discordMessage,
    });
  }

  getSessionId(channelId: string): string | undefined {
    return this.db.getSession(channelId);
  }

  private loadChannelMappings(): void {
    const mappingsPath = path.join(process.cwd(), 'channel-mappings.json');
    if (fs.existsSync(mappingsPath)) {
      try {
        const mappings = JSON.parse(fs.readFileSync(mappingsPath, 'utf-8'));
        this.channelMappings = mappings;
        console.log('Loaded channel mappings:', this.channelMappings);
      } catch (error) {
        console.error('Error loading channel mappings:', error);
      }
    }
  }

  private getFolderName(channelName: string): string {
    // Check if there's a mapping for this channel
    if (this.channelMappings[channelName]) {
      return this.channelMappings[channelName];
    }
    // Otherwise use the channel name as-is
    return channelName;
  }

  async runClaudeCode(
    channelId: string,
    channelName: string,
    prompt: string,
    sessionId?: string,
    discordContext?: DiscordContext
  ): Promise<void> {
    // Store the channel name for path replacement
    this.channelNames.set(channelId, channelName);
    const folderName = this.getFolderName(channelName);
    const workingDir = path.join(this.baseFolder, folderName);
    console.log(`Running Claude Code in: ${workingDir} (channel: ${channelName}, folder: ${folderName})`);

    // Check if working directory exists
    if (!fs.existsSync(workingDir)) {
      throw new Error(`Working directory does not exist: ${workingDir}`);
    }

    const commandString = buildClaudeCommand(workingDir, prompt, sessionId, discordContext);
    console.log(`Running command: ${commandString}`);

    const claude = spawn("/bin/bash", ["-c", commandString], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        SHELL: "/bin/bash",
      },
    });

    console.log(`Claude process spawned with PID: ${claude.pid}`);

    // Update the channel process tracking with actual process
    const channelProcess = this.channelProcesses.get(channelId);
    if (channelProcess) {
      channelProcess.process = claude;
    }

    // Close stdin to signal we're not sending input
    claude.stdin.end();

    // Add immediate listeners to debug
    claude.on("spawn", () => {
      console.log("Process successfully spawned");
    });

    claude.on("error", (error) => {
      console.error("Process spawn error:", error);
    });

    let buffer = "";

    // Set a timeout for the Claude process (5 minutes)
    const timeout = setTimeout(() => {
      console.log("Claude process timed out, killing it");
      claude.kill("SIGTERM");

      const channel = this.channelMessages.get(channelId)?.channel;
      if (channel) {
        const timeoutEmbed = new EmbedBuilder()
          .setTitle("⏰ Timeout")
          .setDescription("Claude Code took too long to respond (5 minutes)")
          .setColor(0xFFD700); // Yellow for timeout
        
        channel.send({ embeds: [timeoutEmbed] }).catch(console.error);
      }
    }, 5 * 60 * 1000); // 5 minutes

    claude.stdout.on("data", (data) => {
      const rawData = data.toString();
      console.log("Raw stdout data:", rawData);
      
      // Log all streamed output to log.txt
      try {
        fs.appendFileSync(path.join(process.cwd(), 'log.txt'), 
          `[${new Date().toISOString()}] Channel: ${channelId}\n${rawData}\n---\n`);
      } catch (error) {
        console.error("Error writing to log.txt:", error);
      }
      
      buffer += rawData;
      
      // Process complete JSON messages
      this.processCompleteJsonMessages(channelId, buffer, timeout, claude);
    });

    claude.on("close", (code) => {
      console.log(`Claude process exited with code ${code}`);
      clearTimeout(timeout);
      // Ensure cleanup on process close
      this.channelProcesses.delete(channelId);

      if (code !== 0 && code !== null) {
        // Process failed - send error embed to Discord
        const channel = this.channelMessages.get(channelId)?.channel;
        if (channel) {
          const errorEmbed = new EmbedBuilder()
            .setTitle("❌ Claude Code Failed")
            .setDescription(`Process exited with code: ${code}`)
            .setColor(0xFF0000); // Red for error
          
          channel.send({ embeds: [errorEmbed] }).catch(console.error);
        }
      }
    });

    claude.stderr.on("data", (data) => {
      const stderrOutput = data.toString();
      console.error("Claude stderr:", stderrOutput);

      // If there's significant stderr output, send warning to Discord
      if (
        stderrOutput.trim() &&
        !stderrOutput.includes("INFO") &&
        !stderrOutput.includes("DEBUG")
      ) {
        const channel = this.channelMessages.get(channelId)?.channel;
        if (channel) {
          const warningEmbed = new EmbedBuilder()
            .setTitle("⚠️ Warning")
            .setDescription(stderrOutput.trim())
            .setColor(0xFFA500); // Orange for warnings
          
          channel.send({ embeds: [warningEmbed] }).catch(console.error);
        }
      }
    });

    claude.on("error", (error) => {
      console.error("Claude process error:", error);
      clearTimeout(timeout);

      // Clean up process tracking on error
      this.channelProcesses.delete(channelId);

      // Send error to Discord
      const channel = this.channelMessages.get(channelId)?.channel;
      if (channel) {
        const processErrorEmbed = new EmbedBuilder()
          .setTitle("❌ Process Error")
          .setDescription(error.message)
          .setColor(0xFF0000); // Red for errors
        
        channel.send({ embeds: [processErrorEmbed] }).catch(console.error);
      }
    });
  }

  private async handleInitMessage(channelId: string, parsed: any): Promise<void> {
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;
    
    const initEmbed = new EmbedBuilder()
      .setTitle("🚀 Claude Code Session Started")
      .setDescription(`**Working Directory:** ${parsed.cwd}\n**Model:** ${parsed.model}\n**Tools:** ${parsed.tools.length} available`)
      .setColor(0x00FF00); // Green for init
    
    try {
      await channel.send({ embeds: [initEmbed] });
    } catch (error) {
      console.error("Error sending init message:", error);
    }
  }

  private async handleAssistantMessage(
    channelId: string,
    parsed: SDKMessage & { type: "assistant" }
  ): Promise<void> {
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    const content = Array.isArray(parsed.message.content)
      ? parsed.message.content.find((c: any) => c.type === "text")?.text || ""
      : parsed.message.content;

    // Check for tool use in the message
    const toolUses = Array.isArray(parsed.message.content)
      ? parsed.message.content.filter((c: any) => c.type === "tool_use")
      : [];

    const toolCalls = this.channelToolCalls.get(channelId) || new Map();

    try {
      // If there's text content, send an assistant message
      if (content && content.trim()) {
        // Check if content would exceed Discord's embed description limit (4096 chars)
        if (content.length > 3800) { // Leave buffer for embed formatting
          // Generate smart summary and create thread/pagination options
          const toolSummary = this.contentSummarizer.generateToolSummary(
            'Claude Response',
            { content: content },
            content,
            false
          );
          
          const assistantEmbed = new EmbedBuilder()
            .setTitle("💬 Claude")
            .setDescription(toolSummary.summary)
            .setColor(0x7289DA); // Discord blurple

          // Create content viewing buttons
          const buttons = this.contentSummarizer.createContentButtons(
            `claude_${Date.now()}`, // Unique ID for this response
            true
          );

          const messagePayload: any = { embeds: [assistantEmbed] };
          if (buttons) {
            messagePayload.components = [buttons];
          }

          const sentMessage = await channel.send(messagePayload);
          
          // Store the full content for button interactions
          const toolId = `claude_${Date.now()}`;
          this.storeToolSummary(channelId, toolId, {
            ...toolSummary,
            details: content // Store full Claude response
          });
        } else {
          // Content fits normally - use existing behavior
          const assistantEmbed = new EmbedBuilder()
            .setTitle("💬 Claude")
            .setDescription(content)
            .setColor(0x7289DA); // Discord blurple
          
          await channel.send({ embeds: [assistantEmbed] });
        }
      }
      
      // If there are tool uses, send a message for each tool
      for (const tool of toolUses) {
        let toolMessage = `🔧 ${tool.name}`;

        // Clean and format inputs for display
        const cleanedInput = { ...tool.input };
        if (tool.input && Object.keys(tool.input).length > 0) {
          const inputs = Object.entries(tool.input)
            .map(([key, value]) => {
              let val = String(value);
              // Replace base folder path with relative path
              const channelName = this.channelNames.get(channelId);
              if (channelName) {
                const folderName = this.getFolderName(channelName);
                const basePath = `${this.baseFolder}${folderName}`;
                if (val === basePath) {
                  val = ".";
                  cleanedInput[key] = val;
                } else if (val.startsWith(basePath + "/")) {
                  val = val.replace(basePath + "/", "./");
                  cleanedInput[key] = val;
                }
              }
              
              // Truncate long values for display
              if (val.length > 100) {
                return `${key}=${val.substring(0, 100)}...`;
              }
              return `${key}=${val}`;
            })
            .join(", ");
          toolMessage += ` (${inputs})`;
        }

        const toolEmbed = new EmbedBuilder()
          .setDescription(`⏳ ${toolMessage}`)
          .setColor(0x0099FF); // Blue for tool calls

        const sentMessage = await channel.send({ embeds: [toolEmbed] });
        
        // Track this tool call message for later updating
        toolCalls.set(tool.id, {
          message: sentMessage,
          toolId: tool.id,
          toolName: tool.name,
          input: cleanedInput
        });
      }

      const channelName = this.channelNames.get(channelId) || "default";
      this.db.setSession(channelId, parsed.session_id, channelName);
      this.channelToolCalls.set(channelId, toolCalls);
    } catch (error) {
      console.error("Error sending assistant message:", error);
    }
  }

  private async handleToolResultMessage(channelId: string, parsed: any): Promise<void> {
    const toolResults = Array.isArray(parsed.message.content)
      ? parsed.message.content.filter((c: any) => c.type === "tool_result")
      : [];

    if (toolResults.length === 0) return;

    const toolCalls = this.channelToolCalls.get(channelId) || new Map();
    const channel = this.channelMessages.get(channelId)?.channel;

    for (const result of toolResults) {
      const toolCall = toolCalls.get(result.tool_use_id);
      if (toolCall && toolCall.message) {
        try {
          // Get the first line of the result
          const firstLine = result.content.split('\n')[0].trim();
          const resultText = firstLine.length > 100 
            ? firstLine.substring(0, 100) + "..."
            : firstLine;
          
          // Get the current embed and update it
          const currentEmbed = toolCall.message.embeds[0];
          const originalDescription = currentEmbed.data.description.replace("⏳", "✅");
          const isError = result.is_error === true;
          
          const updatedEmbed = new EmbedBuilder();
          
          if (isError) {
            updatedEmbed
              .setDescription(`❌ ${originalDescription.substring(2)}\n*${resultText}*`)
              .setColor(0xFF0000); // Red for errors
          } else {
            updatedEmbed
              .setDescription(`${originalDescription}\n*${resultText}*`)
              .setColor(0x00FF00); // Green for completed
          }

          await toolCall.message.edit({ embeds: [updatedEmbed] });

        } catch (error) {
          console.error("Error updating tool result message:", error);
        }
      }
    }
  }

  private async handleResultMessage(
    channelId: string,
    parsed: SDKMessage & { type: "result" }
  ): Promise<void> {
    console.log("Result message:", parsed);
    const channelName = this.channelNames.get(channelId) || "default";
    this.db.setSession(channelId, parsed.session_id, channelName);

    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    // Create a final result embed
    const resultEmbed = new EmbedBuilder();

    if (parsed.subtype === "success") {
      let description = "result" in parsed ? parsed.result : "Task completed";
      description += `\n\n*Completed in ${parsed.num_turns} turns*`;
      
      resultEmbed
        .setTitle("✅ Session Complete")
        .setDescription(description)
        .setColor(0x00FF00); // Green for success
    } else {
      resultEmbed
        .setTitle("❌ Session Failed")
        .setDescription(`Task failed: ${parsed.subtype}`)
        .setColor(0xFF0000); // Red for failure
    }

    try {
      await channel.send({ embeds: [resultEmbed] });
    } catch (error) {
      console.error("Error sending result message:", error);
    }

    console.log("Got result message, cleaning up process tracking");
  }

  /**
   * Process complete JSON messages from Claude Code stream
   */
  private processCompleteJsonMessages(channelId: string, buffer: string, timeout: any, claude: any): void {
    const existingBuffer = this.jsonBuffers.get(channelId) || '';
    const fullBuffer = existingBuffer + buffer;
    
    const lines = fullBuffer.split('\n');
    let remainingBuffer = '';
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      try {
        // Try to parse as complete JSON
        const parsed: SDKMessage = JSON.parse(line);
        console.log("Parsed message type:", parsed.type);
        
        // Successfully parsed - process the message
        if (parsed.type === "assistant" && parsed.message.content) {
          this.handleLargeAssistantMessage(channelId, parsed).catch(console.error);
        } else if (parsed.type === "user" && parsed.message.content) {
          this.handleToolResultMessage(channelId, parsed).catch(console.error);
        } else if (parsed.type === "result") {
          this.handleResultMessage(channelId, parsed).then(() => {
            clearTimeout(timeout);
            claude.kill("SIGTERM");
            this.channelProcesses.delete(channelId);
          }).catch(console.error);
        } else if (parsed.type === "system") {
          console.log("System message:", parsed.subtype);
          if (parsed.subtype === "init") {
            this.handleInitMessage(channelId, parsed).catch(console.error);
          }
          const channelName = this.channelNames.get(channelId) || "default";
          this.db.setSession(channelId, parsed.session_id, channelName);
        }
        
      } catch (error) {
        // If this is the last line and it's incomplete, keep it in buffer
        if (i === lines.length - 1) {
          remainingBuffer = line;
          console.log(`Buffering incomplete JSON (${line.length} chars): ${line.substring(0, 100)}...`);
        } else {
          // Error parsing a complete line - log it
          console.error("Error parsing JSON:", error.message);
          console.log("Problematic line (first 200 chars):", line.substring(0, 200));
        }
      }
    }
    
    // Update buffer with any remaining incomplete JSON
    this.jsonBuffers.set(channelId, remainingBuffer);
  }

  /**
   * Handle assistant messages with large content detection
   */
  private async handleLargeAssistantMessage(
    channelId: string,
    parsed: SDKMessage & { type: "assistant" }
  ): Promise<void> {
    // Check if any tool_use has very large content that might cause issues
    const content = Array.isArray(parsed.message.content)
      ? parsed.message.content.find((c: any) => c.type === "text")?.text || ""
      : parsed.message.content;

    const toolUses = Array.isArray(parsed.message.content)
      ? parsed.message.content.filter((c: any) => c.type === "tool_use")
      : [];

    // Check for oversized tool operations
    const hasLargeToolContent = toolUses.some((tool: any) => {
      const inputStr = JSON.stringify(tool.input || {});
      return inputStr.length > 50000; // 50KB threshold for tool input
    });

    if (hasLargeToolContent) {
      console.log("Detected large tool content, using smart processing");
      // Handle large tool operations specially
      await this.handleLargeToolOperations(channelId, parsed, toolUses);
    } else {
      // Normal processing
      await this.handleAssistantMessage(channelId, parsed);
    }
  }

  /**
   * Handle tool operations with large content
   */
  private async handleLargeToolOperations(
    channelId: string,
    parsed: SDKMessage & { type: "assistant" },
    toolUses: any[]
  ): Promise<void> {
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    const content = Array.isArray(parsed.message.content)
      ? parsed.message.content.find((c: any) => c.type === "text")?.text || ""
      : parsed.message.content;

    const toolCalls = this.channelToolCalls.get(channelId) || new Map();

    try {
      // Send assistant text if present
      if (content && content.trim()) {
        await this.handleAssistantMessage(channelId, parsed);
      }
      
      // Handle each large tool operation
      for (const tool of toolUses) {
        const inputSize = JSON.stringify(tool.input || {}).length;
        
        if (inputSize > 50000) {
          // Generate smart summary for large tool operation
          const toolSummary = this.contentSummarizer.generateToolSummary(
            tool.name,
            tool.input,
            `Large ${tool.name} operation (${Math.round(inputSize/1024)}KB)`,
            false
          );
          
          const toolEmbed = new EmbedBuilder()
            .setTitle("🔧 Large Operation")
            .setDescription(`⏳ ${toolSummary.summary}`)
            .setColor(0x0099FF);

          // Create content viewing buttons
          const buttons = this.contentSummarizer.createContentButtons(
            tool.id,
            true
          );

          const messagePayload: any = { embeds: [toolEmbed] };
          if (buttons) {
            messagePayload.components = [buttons];
          }

          const sentMessage = await channel.send(messagePayload);

          // Store tool summary for button interactions
          this.storeToolSummary(channelId, tool.id, {
            ...toolSummary,
            details: JSON.stringify(tool.input, null, 2) // Store formatted input
          });

          // Track this tool call
          toolCalls.set(tool.id, {
            message: sentMessage,
            toolId: tool.id,
            toolName: tool.name,
            input: { large_content: true, size_kb: Math.round(inputSize/1024) }
          });
        } else {
          // Normal tool processing
          let toolMessage = `🔧 ${tool.name}`;
          if (tool.input && Object.keys(tool.input).length > 0) {
            const inputs = Object.entries(tool.input)
              .map(([key, value]) => `${key}=${String(value).substring(0, 50)}${String(value).length > 50 ? '...' : ''}`)
              .join(", ");
            toolMessage += ` (${inputs})`;
          }

          const toolEmbed = new EmbedBuilder()
            .setDescription(`⏳ ${toolMessage}`)
            .setColor(0x0099FF);

          const sentMessage = await channel.send({ embeds: [toolEmbed] });
          
          toolCalls.set(tool.id, {
            message: sentMessage,
            toolId: tool.id,
            toolName: tool.name,
            input: tool.input
          });
        }
      }

      const channelName = this.channelNames.get(channelId) || "default";
      this.db.setSession(channelId, parsed.session_id, channelName);
      this.channelToolCalls.set(channelId, toolCalls);
    } catch (error) {
      console.error("Error handling large tool operations:", error);
    }
  }

  /**
   * Store tool summary for button interactions
   */
  private storeToolSummary(channelId: string, toolId: string, summary: any): void {
    if (!this.toolSummaries.has(channelId)) {
      this.toolSummaries.set(channelId, new Map());
    }
    this.toolSummaries.get(channelId)!.set(toolId, summary);
  }

  /**
   * Get stored tool summary
   */
  getToolSummary(channelId: string, toolId: string): any {
    return this.toolSummaries.get(channelId)?.get(toolId);
  }

  /**
   * Handle button interactions for content viewing
   */
  async handleContentViewButton(
    channelId: string, 
    toolId: string, 
    action: 'thread' | 'paginate',
    interaction: any
  ): Promise<void> {
    const summary = this.getToolSummary(channelId, toolId);
    if (!summary) {
      await interaction.reply({ 
        content: "Content not found or expired", 
        ephemeral: true 
      });
      return;
    }

    try {
      if (action === 'thread') {
        const thread = await this.contentSummarizer.createContentThread(
          interaction.channel,
          summary,
          toolId
        );
        
        if (thread) {
          await interaction.reply({ 
            content: `📄 Full content available in ${thread}`, 
            ephemeral: true 
          });
        } else {
          await interaction.reply({ 
            content: "Failed to create thread", 
            ephemeral: true 
          });
        }
      } else if (action === 'paginate') {
        const messages = await this.contentSummarizer.createPaginatedView(
          interaction.channel,
          summary,
          toolId
        );
        
        if (messages.length > 0) {
          await interaction.reply({ 
            content: `📄 Content displayed in ${messages.length} page${messages.length > 1 ? 's' : ''}`, 
            ephemeral: true 
          });
        } else {
          await interaction.reply({ 
            content: "Failed to create paginated view", 
            ephemeral: true 
          });
        }
      }
    } catch (error) {
      console.error("Error handling content view button:", error);
      await interaction.reply({ 
        content: "Error displaying content", 
        ephemeral: true 
      });
    }
  }



  // Clean up resources
  destroy(): void {
    // Close all active processes
    for (const [channelId] of this.channelProcesses) {
      this.killActiveProcess(channelId);
    }
    
    // Close database connection
    this.db.close();
  }
}
