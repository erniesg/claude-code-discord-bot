import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import type { SDKMessage } from "../types/index.js";
import { buildClaudeCommand } from "../utils/shell.js";

export class ClaudeManager {
  private channelSessions = new Map<string, string>();
  private channelMessages = new Map<string, any>();
  private channelResponses = new Map<string, string[]>();
  private channelNames = new Map<string, string>();
  private channelProcesses = new Map<
    string,
    {
      process: any;
      sessionId?: string;
      discordMessage: any;
    }
  >();

  constructor(private baseFolder: string) {}

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
    this.channelSessions.delete(channelId);
    this.channelMessages.delete(channelId);
    this.channelResponses.delete(channelId);
    this.channelNames.delete(channelId);
    this.channelProcesses.delete(channelId);
  }

  setDiscordMessage(channelId: string, message: any): void {
    this.channelMessages.set(channelId, message);
    this.channelResponses.set(channelId, []);
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
    return this.channelSessions.get(channelId);
  }

  async runClaudeCode(
    channelId: string,
    channelName: string,
    prompt: string,
    sessionId?: string
  ): Promise<void> {
    // Store the channel name for path replacement
    this.channelNames.set(channelId, channelName);
    const workingDir = path.join(this.baseFolder, channelName);
    console.log(`Running Claude Code in: ${workingDir}`);

    // Check if working directory exists
    if (!fs.existsSync(workingDir)) {
      throw new Error(`Working directory does not exist: ${workingDir}`);
    }

    const commandString = buildClaudeCommand(workingDir, prompt, sessionId);
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
    const responses: string[] = [];

    // Set a timeout for the Claude process (5 minutes)
    const timeout = setTimeout(() => {
      console.log("Claude process timed out, killing it");
      claude.kill("SIGTERM");

      const response = `⏰ **Timeout**: Claude Code took too long to respond (5 minutes)`;
      const currentResponses = this.channelResponses.get(channelId) || [];
      currentResponses.push(response);
      this.channelResponses.set(channelId, currentResponses);
      this.updateDiscordMessage(channelId);
    }, 5 * 60 * 1000); // 5 minutes

    claude.stdout.on("data", (data) => {
      console.log("Raw stdout data:", data.toString());
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          console.log("Processing line:", line);
          try {
            const parsed: SDKMessage = JSON.parse(line);
            console.log("Parsed message type:", parsed.type);

            if (parsed.type === "assistant" && parsed.message.content) {
              this.handleAssistantMessage(channelId, parsed, responses);
            } else if (parsed.type === "result") {
              this.handleResultMessage(channelId, parsed);
              clearTimeout(timeout);
              claude.kill("SIGTERM");
              this.channelProcesses.delete(channelId);
            } else if (parsed.type === "system") {
              console.log("System message:", parsed.subtype);
              this.channelSessions.set(channelId, parsed.session_id);
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
        // Process failed - add error message to Discord
        const response = `❌ **Claude Code failed** (exit code: ${code})`;
        const currentResponses = this.channelResponses.get(channelId) || [];
        currentResponses.push(response);
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
        const response = `⚠️ **Error**: ${stderrOutput.trim()}`;
        const currentResponses = this.channelResponses.get(channelId) || [];
        currentResponses.push(response);
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
      const response = `❌ **Process Error**: ${error.message}`;
      const currentResponses = this.channelResponses.get(channelId) || [];
      currentResponses.push(response);
      this.channelResponses.set(channelId, currentResponses);
      this.updateDiscordMessage(channelId);
    });
  }

  private handleAssistantMessage(
    channelId: string,
    parsed: SDKMessage & { type: "assistant" },
    responses: string[]
  ): void {
    const content = Array.isArray(parsed.message.content)
      ? parsed.message.content.find((c: any) => c.type === "text")?.text || ""
      : parsed.message.content;

    console.log("Assistant content:", content);
    console.log("Current responses array length:", responses.length);

    // Check for tool use in the message
    const toolUses = Array.isArray(parsed.message.content)
      ? parsed.message.content.filter((c: any) => c.type === "tool_use")
      : [];

    // If there's text content, add it
    if (content && content.trim()) {
      const currentResponses = this.channelResponses.get(channelId) || [];
      currentResponses.push(content);
      this.channelSessions.set(channelId, parsed.session_id);

      // Keep only last 20 lines
      if (currentResponses.length > 20) {
        currentResponses.shift();
      }

      this.channelResponses.set(channelId, [...currentResponses]);
      console.log(
        "Updated channelResponses for",
        channelId,
        ":",
        currentResponses
      );
      this.updateDiscordMessage(channelId);
    }
    // If no text but there are tool uses, show tool activity
    else if (toolUses.length > 0) {
      const currentResponses = this.channelResponses.get(channelId) || [];

      // Process each tool use
      toolUses.forEach((tool: any) => {
        console.log(tool);

        let toolMessage = `🔧 ${tool.name} `;

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
              return `${key}: ${val}`;
            })
            .join(", ");
          toolMessage += `(${inputs})`;
        }

        currentResponses.push(toolMessage);
      });

      // Keep only last 20 lines
      if (currentResponses.length > 20) {
        currentResponses.shift();
      }

      this.channelSessions.set(channelId, parsed.session_id);
      this.channelResponses.set(channelId, [...currentResponses]);
      console.log(
        "Updated channelResponses for tool use",
        channelId,
        ":",
        currentResponses
      );
      this.updateDiscordMessage(channelId);
    }
  }

  private handleResultMessage(
    channelId: string,
    parsed: SDKMessage & { type: "result" }
  ): void {
    console.log("Result message:", parsed);
    this.channelSessions.set(channelId, parsed.session_id);

    // Get current responses from the channel (includes all tool logs)
    const currentResponses = this.channelResponses.get(channelId) || [];

    // If no responses were captured, use the result directly (only for success)
    if (
      currentResponses.length === 0 &&
      parsed.subtype === "success" &&
      "result" in parsed
    ) {
      currentResponses.push(parsed.result);
    }

    // Append completion message to existing responses
    if (parsed.subtype === "success") {
      currentResponses.push(`✅ **Completed** (${parsed.num_turns} turns)`);
    } else {
      currentResponses.push(`❌ **Error** (${parsed.subtype})`);
    }

    // Keep only last 20 lines
    if (currentResponses.length > 20) {
      currentResponses.shift();
    }

    this.channelResponses.set(channelId, [...currentResponses]);
    console.log(
      "Updated channelResponses for result",
      channelId,
      ":",
      currentResponses
    );
    this.updateDiscordMessage(channelId);

    console.log("Got result message, cleaning up process tracking");
  }

  private async updateDiscordMessage(channelId: string): Promise<void> {
    const message = this.channelMessages.get(channelId);
    const responses = this.channelResponses.get(channelId) || [];

    if (message && responses.length > 0) {
      const content = responses.join("\n");
      const truncatedContent =
        content.length > 2000 ? content.substring(0, 1900) + "..." : content;

      try {
        console.log("Updating Discord message with content:", truncatedContent);
        await message.edit(truncatedContent || "Processing...");
      } catch (error) {
        console.error("Error updating message:", error);
      }
    } else {
      console.log("No message or responses to update:", {
        hasMessage: !!message,
        responsesLength: responses.length,
      });
    }
  }
}
