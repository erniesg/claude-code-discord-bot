import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { EmbedBuilder } from "discord.js";
import type { SDKMessage } from "../types/index.js";
import { buildClaudeCommand, type DiscordContext } from "../utils/shell.js";
import { DatabaseManager } from "../db/database.js";

export class ClaudeManager {
  private db: DatabaseManager;
  private channelMessages = new Map<string, any>();
  private channelResponses = new Map<string, { embeds: any[], textContent: string }>();
  private channelToolCalls = new Map<string, Map<string, any>>();
  private channelNames = new Map<string, string>();
  private channelProcesses = new Map<
    string,
    {
      process: any;
      sessionId?: string;
      discordMessage: any;
    }
  >();

  constructor(private baseFolder: string) {
    this.db = new DatabaseManager();
    // Clean up old sessions on startup
    this.db.cleanupOldSessions();
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
    this.channelResponses.delete(channelId);
    this.channelToolCalls.delete(channelId);
    this.channelNames.delete(channelId);
    this.channelProcesses.delete(channelId);
  }

  setDiscordMessage(channelId: string, message: any): void {
    this.channelMessages.set(channelId, message);
    this.channelResponses.set(channelId, { embeds: [], textContent: "" });
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

  async runClaudeCode(
    channelId: string,
    channelName: string,
    prompt: string,
    sessionId?: string,
    discordContext?: DiscordContext
  ): Promise<void> {
    // Store the channel name for path replacement
    this.channelNames.set(channelId, channelName);
    const workingDir = path.join(this.baseFolder, channelName);
    console.log(`Running Claude Code in: ${workingDir}`);

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

      const timeoutEmbed = new EmbedBuilder()
        .setTitle("⏰ Timeout")
        .setDescription("Claude Code took too long to respond (5 minutes)")
        .setColor(0xFFD700); // Yellow for timeout
      
      const currentResponses = this.channelResponses.get(channelId) || { embeds: [], textContent: "" };
      currentResponses.embeds.push(timeoutEmbed);
      this.channelResponses.set(channelId, currentResponses);
      this.updateDiscordMessage(channelId);
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
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          console.log("Processing line:", line);
          try {
            const parsed: SDKMessage = JSON.parse(line);
            console.log("Parsed message type:", parsed.type);

            if (parsed.type === "assistant" && parsed.message.content) {
              this.handleAssistantMessage(channelId, parsed);
            } else if (parsed.type === "user" && parsed.message.content) {
              this.handleToolResultMessage(channelId, parsed);
            } else if (parsed.type === "result") {
              this.handleResultMessage(channelId, parsed);
              clearTimeout(timeout);
              claude.kill("SIGTERM");
              this.channelProcesses.delete(channelId);
            } else if (parsed.type === "system") {
              console.log("System message:", parsed.subtype);
              if (parsed.subtype === "init") {
                this.handleInitMessage(channelId, parsed);
              }
              const channelName = this.channelNames.get(channelId) || "default";
              this.db.setSession(channelId, parsed.session_id, channelName);
            }
          } catch (error) {
            console.error("Error parsing JSON:", error, "Line:", line);
          }
        }
      }
    });

    claude.on("close", (code) => {
      console.log(`Claude process exited with code ${code}`);
      clearTimeout(timeout);
      // Ensure cleanup on process close
      this.channelProcesses.delete(channelId);

      if (code !== 0 && code !== null) {
        // Process failed - add error embed to Discord
        const errorEmbed = new EmbedBuilder()
          .setTitle("❌ Claude Code Failed")
          .setDescription(`Process exited with code: ${code}`)
          .setColor(0xFF0000); // Red for error
        
        const currentResponses = this.channelResponses.get(channelId) || { embeds: [], textContent: "" };
        currentResponses.embeds.push(errorEmbed);
        this.channelResponses.set(channelId, currentResponses);
        this.updateDiscordMessage(channelId);
      }
    });

    claude.stderr.on("data", (data) => {
      const stderrOutput = data.toString();
      console.error("Claude stderr:", stderrOutput);

      // If there's significant stderr output, add it to Discord
      if (
        stderrOutput.trim() &&
        !stderrOutput.includes("INFO") &&
        !stderrOutput.includes("DEBUG")
      ) {
        const warningEmbed = new EmbedBuilder()
          .setTitle("⚠️ Warning")
          .setDescription(stderrOutput.trim())
          .setColor(0xFFA500); // Orange for warnings
        
        const currentResponses = this.channelResponses.get(channelId) || { embeds: [], textContent: "" };
        currentResponses.embeds.push(warningEmbed);
        this.channelResponses.set(channelId, currentResponses);
        this.updateDiscordMessage(channelId);
      }
    });

    claude.on("error", (error) => {
      console.error("Claude process error:", error);
      clearTimeout(timeout);

      // Clean up process tracking on error
      this.channelProcesses.delete(channelId);

      // Update Discord with the error
      const processErrorEmbed = new EmbedBuilder()
        .setTitle("❌ Process Error")
        .setDescription(error.message)
        .setColor(0xFF0000); // Red for errors
      
      const currentResponses = this.channelResponses.get(channelId) || { embeds: [], textContent: "" };
      currentResponses.embeds.push(processErrorEmbed);
      this.channelResponses.set(channelId, currentResponses);
      this.updateDiscordMessage(channelId);
    });
  }

  private handleInitMessage(channelId: string, parsed: any): void {
    const currentResponses = this.channelResponses.get(channelId) || { embeds: [], textContent: "" };
    
    const initEmbed = new EmbedBuilder()
      .setTitle("🚀 Claude Code Session Started")
      .setDescription(`**Working Directory:** ${parsed.cwd}\n**Model:** ${parsed.model}\n**Tools:** ${parsed.tools.length} available`)
      .setColor(0x00FF00); // Green for init
    
    currentResponses.embeds.push(initEmbed);
    this.channelResponses.set(channelId, currentResponses);
    this.updateDiscordMessage(channelId);
  }

  private handleAssistantMessage(
    channelId: string,
    parsed: SDKMessage & { type: "assistant" }
  ): void {
    const content = Array.isArray(parsed.message.content)
      ? parsed.message.content.find((c: any) => c.type === "text")?.text || ""
      : parsed.message.content;

    // Check for tool use in the message
    const toolUses = Array.isArray(parsed.message.content)
      ? parsed.message.content.filter((c: any) => c.type === "tool_use")
      : [];

    const currentResponses = this.channelResponses.get(channelId) || { embeds: [], textContent: "" };
    const toolCalls = this.channelToolCalls.get(channelId) || new Map();

    // If there's text content, create an assistant message embed
    if (content && content.trim()) {
      const assistantEmbed = new EmbedBuilder()
        .setTitle("💬 Claude")
        .setDescription(content)
        .setColor(0x7289DA); // Discord blurple
      
      currentResponses.embeds.push(assistantEmbed);
    }
    
    // If there are tool uses, create embeds for each and track them
    if (toolUses.length > 0) {
      toolUses.forEach((tool: any) => {
        let toolMessage = `🔧 ${tool.name}`;

        if (tool.input && Object.keys(tool.input).length > 0) {
          const inputs = Object.entries(tool.input)
            .map(([key, value]) => {
              let val = String(value);
              // Replace base folder path with relative path
              const channelName = this.channelNames.get(channelId);
              if (channelName) {
                const basePath = `${this.baseFolder}${channelName}`;
                if (val === basePath) {
                  val = ".";
                } else if (val.startsWith(basePath + "/")) {
                  val = val.replace(basePath + "/", "./");
                }
              }
              return `${key}=${val}`;
            })
            .join(", ");
          toolMessage += ` (${inputs})`;
        }

        const toolEmbed = new EmbedBuilder()
          .setDescription(`⏳ ${toolMessage}`)
          .setColor(0x0099FF); // Blue for tool calls

        currentResponses.embeds.push(toolEmbed);
        
        // Track this tool call for later updating
        toolCalls.set(tool.id, {
          embed: toolEmbed,
          embedIndex: currentResponses.embeds.length - 1
        });
      });
    }

    // Keep only last 10 embeds to avoid hitting Discord limits
    if (currentResponses.embeds.length > 10) {
      currentResponses.embeds = currentResponses.embeds.slice(-10);
    }

    const channelName = this.channelNames.get(channelId) || "default";
    this.db.setSession(channelId, parsed.session_id, channelName);
    this.channelResponses.set(channelId, currentResponses);
    this.channelToolCalls.set(channelId, toolCalls);
    this.updateDiscordMessage(channelId);
  }

  private handleToolResultMessage(channelId: string, parsed: any): void {
    const toolResults = Array.isArray(parsed.message.content)
      ? parsed.message.content.filter((c: any) => c.type === "tool_result")
      : [];

    if (toolResults.length === 0) return;

    const currentResponses = this.channelResponses.get(channelId) || { embeds: [], textContent: "" };
    const toolCalls = this.channelToolCalls.get(channelId) || new Map();

    toolResults.forEach((result: any) => {
      const toolCall = toolCalls.get(result.tool_use_id);
      if (toolCall) {
        // Get the first line of the result
        const firstLine = result.content.split('\n')[0].trim();
        const resultText = firstLine.length > 100 
          ? firstLine.substring(0, 100) + "..."
          : firstLine;
        
        // Update the existing tool embed with the result
        const originalDescription = toolCall.embed.data.description.replace("⏳", "✅");
        const isError = result.is_error === true;
        
        if (isError) {
          toolCall.embed.setDescription(`❌ ${originalDescription.substring(2)}\n*${resultText}*`);
          toolCall.embed.setColor(0xFF0000); // Red for errors
        } else {
          toolCall.embed.setDescription(`${originalDescription}\n*${resultText}*`);
          toolCall.embed.setColor(0x00FF00); // Green for completed
        }
      }
    });

    this.channelResponses.set(channelId, currentResponses);
    this.updateDiscordMessage(channelId);
  }

  private handleResultMessage(
    channelId: string,
    parsed: SDKMessage & { type: "result" }
  ): void {
    console.log("Result message:", parsed);
    const channelName = this.channelNames.get(channelId) || "default";
    this.db.setSession(channelId, parsed.session_id, channelName);

    const currentResponses = this.channelResponses.get(channelId) || { embeds: [], textContent: "" };

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

    currentResponses.embeds.push(resultEmbed);
    // Clear text content - we only want embeds
    currentResponses.textContent = "";
    this.channelResponses.set(channelId, currentResponses);
    this.updateDiscordMessage(channelId);

    console.log("Got result message, cleaning up process tracking");
  }


  private async updateDiscordMessage(channelId: string): Promise<void> {
    const message = this.channelMessages.get(channelId);
    const responses = this.channelResponses.get(channelId);

    if (message && responses) {
      try {
        const messageOptions: any = {
          allowedMentions: { parse: [] },
          content: "" // Always empty - we only want embeds
        };

        // Add embeds if present (Discord limit is 10 embeds per message)
        if (responses.embeds.length > 0) {
          messageOptions.embeds = responses.embeds.slice(-10);
        } else {
          // Show processing embed if no embeds yet
          messageOptions.embeds = [
            new EmbedBuilder()
              .setTitle("⏳ Processing...")
              .setDescription("Claude Code is starting up")
              .setColor(0xFFD700)
          ];
        }

        console.log("Updating Discord message with embeds:", responses.embeds.length);
        await message.edit(messageOptions);
      } catch (error) {
        console.error("Error updating message:", error);
      }
    } else {
      console.log("No message or responses to update:", {
        hasMessage: !!message,
        hasResponses: !!responses,
        embedsLength: responses?.embeds?.length || 0,
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
