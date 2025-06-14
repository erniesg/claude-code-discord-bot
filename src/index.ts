import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
} from "discord.js";
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";

type SDKMessage =
  | {
      type: "assistant";
      message: any;
      session_id: string;
    }
  | {
      type: "user";
      message: any;
      session_id: string;
    }
  | {
      type: "result";
      subtype: "success";
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      num_turns: number;
      result: string;
      session_id: string;
      total_cost_usd: number;
    }
  | {
      type: "result";
      subtype: "error_max_turns" | "error_during_execution";
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      num_turns: number;
      session_id: string;
      total_cost_usd: number;
    }
  | {
      type: "system";
      subtype: "init";
      apiKeySource: string;
      cwd: string;
      session_id: string;
      tools: string[];
      mcp_servers: {
        name: string;
        status: string;
      }[];
      model: string;
      permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
    };

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Session tracking per channel
const channelSessions = new Map<string, string>();
const channelMessages = new Map<string, any>();
const channelResponses = new Map<string, string[]>();

// Active processes per channel - prevents multiple spawns
const channelProcesses = new Map<
  string,
  {
    process: any;
    sessionId?: string;
    discordMessage: any;
  }
>();

client.once("ready", async () => {
  console.log(`Bot is ready! Logged in as ${client.user?.tag}`);

  // Register slash commands
  const commands = [
    new SlashCommandBuilder()
      .setName("clear")
      .setDescription("Clear the current Claude Code session"),
  ];

  const rest = new REST().setToken(process.env.DISCORD_TOKEN!);

  try {
    await rest.put(Routes.applicationCommands(client.user!.id), {
      body: commands,
    });
    console.log("Successfully registered application commands.");
  } catch (error) {
    console.error(error);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const allowedUserId = process.env.ALLOWED_USER_ID;
  if (interaction.user.id !== allowedUserId) {
    await interaction.reply({
      content: "You are not authorized to use this bot.",
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "clear") {
    const channelId = interaction.channelId;

    // Kill any active process for this channel
    const activeProcess = channelProcesses.get(channelId);
    if (activeProcess?.process) {
      console.log(`Killing active process for channel ${channelId}`);
      activeProcess.process.kill("SIGTERM");
    }

    // Clear all channel data
    channelSessions.delete(channelId);
    channelMessages.delete(channelId);
    channelResponses.delete(channelId);
    channelProcesses.delete(channelId);

    await interaction.reply(
      "Session cleared! Next message will start a new Claude Code session."
    );
  }
});

async function runClaudeCode(
  channelId: string,
  channelName: string,
  prompt: string,
  sessionId?: string
) {
  const baseFolder = process.env.BASE_FOLDER;
  if (!baseFolder) {
    throw new Error("BASE_FOLDER environment variable is required");
  }

  const workingDir = path.join(baseFolder, channelName);
  console.log(`Running Claude Code in: ${workingDir}`);

  // Check if working directory exists
  if (!fs.existsSync(workingDir)) {
    throw new Error(`Working directory does not exist: ${workingDir}`);
  }

  const args = [
    "--output-format",
    "stream-json",
    "--model",
    "sonnet",
    "-p",
    prompt, // Don't quote here since we'll handle it in command building
    "--verbose",
  ];

  if (sessionId) {
    args.unshift("--resume", sessionId);
    console.log(`Resuming session: ${sessionId}`);
  }

  console.log(`Command: claude ${args.join(" ")}`);

  // Properly escape the prompt for shell execution
  // Replace ' with '\'' and wrap in single quotes
  const escapedPrompt = prompt.replace(/'/g, "'\\''");

  // Build command with proper escaping
  const commandParts = [
    `cd ${workingDir}`,
    "&&",
    "claude",
    "--output-format",
    "stream-json",
    "--model",
    "sonnet",
    "-p",
    `'${escapedPrompt}'`, // Use single quotes with proper escaping
    "--verbose",
  ];

  if (sessionId) {
    commandParts.splice(3, 0, "--resume", sessionId);
  }

  const commandString = commandParts.join(" ");
  console.log(`Running command: ${commandString}`);

  // Use exact same spawn as test.ts
  const claude = spawn("/bin/bash", ["-c", commandString], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      SHELL: "/bin/bash",
    },
  });

  console.log(`Claude process spawned with PID: ${claude.pid}`);

  // Update the channel process tracking with actual process
  const channelProcess = channelProcesses.get(channelId);
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
    const currentResponses = channelResponses.get(channelId) || [];
    currentResponses.push(response);
    channelResponses.set(channelId, currentResponses);
    updateDiscordMessage(channelId);
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
            const content = Array.isArray(parsed.message.content)
              ? parsed.message.content.find((c: any) => c.type === "text")
                  ?.text || ""
              : parsed.message.content;

            console.log("Assistant content:", content);

            // Check for tool use in the message
            const toolUses = Array.isArray(parsed.message.content)
              ? parsed.message.content.filter((c: any) => c.type === "tool_use")
              : [];

            // If there's text content, add it
            if (content && content.trim()) {
              responses.push(content);
              channelSessions.set(channelId, parsed.session_id);

              // Keep only last 3 responses
              if (responses.length > 3) {
                responses.shift();
              }

              channelResponses.set(channelId, [...responses]);
              updateDiscordMessage(channelId);
            }
            // If no text but there are tool uses, show tool activity
            else if (toolUses.length > 0) {
              const toolNames = toolUses.map((t: any) => t.name).join(", ");
              const toolMessage = `🔧 Using tools: ${toolNames}`;

              // Update the last response or add a new one to show current activity
              const currentResponses = channelResponses.get(channelId) || [];

              // Replace the last "Using tools" message or add a new one
              if (
                currentResponses.length > 0 &&
                currentResponses[currentResponses.length - 1]?.startsWith(
                  "🔧 Using tools:"
                )
              ) {
                currentResponses[currentResponses.length - 1] = toolMessage;
              } else {
                currentResponses.push(toolMessage);
                // Keep only last 3 responses
                if (currentResponses.length > 3) {
                  currentResponses.shift();
                }
              }

              channelSessions.set(channelId, parsed.session_id);
              channelResponses.set(channelId, [...currentResponses]);
              updateDiscordMessage(channelId);
            }
          } else if (parsed.type === "result") {
            console.log("Result message:", parsed);
            channelSessions.set(channelId, parsed.session_id);
            clearTimeout(timeout); // Clear timeout since we got a result

            // If no responses were captured, use the result directly (only for success)
            if (
              responses.length === 0 &&
              parsed.subtype === "success" &&
              "result" in parsed
            ) {
              responses.push(parsed.result);
            }

            if (parsed.subtype === "success") {
              responses.push(
                `\n✅ **Completed** (${
                  parsed.num_turns
                } turns, $${parsed.total_cost_usd.toFixed(4)})`
              );
            } else {
              responses.push(`\n❌ **Error** (${parsed.subtype})`);
            }

            channelResponses.set(channelId, [...responses]);
            updateDiscordMessage(channelId);

            // Clean up the channel process tracking
            console.log("Got result message, cleaning up process tracking");
            channelProcesses.delete(channelId);
          } else if (parsed.type === "system") {
            console.log("System message:", parsed.subtype);
            channelSessions.set(channelId, parsed.session_id);
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
    channelProcesses.delete(channelId);

    if (code !== 0) {
      // Process failed - add error message to Discord
      const response = `❌ **Claude Code failed** (exit code: ${code})`;
      const currentResponses = channelResponses.get(channelId) || [];
      currentResponses.push(response);
      channelResponses.set(channelId, currentResponses);
      updateDiscordMessage(channelId);
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
      const currentResponses = channelResponses.get(channelId) || [];
      currentResponses.push(response);
      channelResponses.set(channelId, currentResponses);
      updateDiscordMessage(channelId);
    }
  });

  claude.on("error", (error) => {
    console.error("Claude process error:", error);
    clearTimeout(timeout);

    // Clean up process tracking on error
    channelProcesses.delete(channelId);

    // Update Discord with the error
    const response = `❌ **Process Error**: ${error.message}`;
    const currentResponses = channelResponses.get(channelId) || [];
    currentResponses.push(response);
    channelResponses.set(channelId, currentResponses);
    updateDiscordMessage(channelId);
  });
}

async function updateDiscordMessage(channelId: string) {
  const message = channelMessages.get(channelId);
  const responses = channelResponses.get(channelId) || [];

  if (message && responses.length > 0) {
    const content = responses.join("\n\n---\n\n");
    const truncatedContent =
      content.length > 2000 ? content.substring(0, 1900) + "..." : content;

    try {
      await message.edit(truncatedContent || "Processing...");
    } catch (error) {
      console.error("Error updating message:", error);
    }
  }
}

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  console.log("MESSAGE CREATED", message.id);

  const allowedUserId = process.env.ALLOWED_USER_ID;
  if (message.author.id !== allowedUserId) {
    return;
  }

  const channelId = message.channelId;

  // Atomic check-and-lock: if channel is already processing, skip
  if (channelProcesses.has(channelId)) {
    console.log(
      `Channel ${channelId} is already processing, skipping new message`
    );
    return;
  }
  const channelName =
    message.channel && "name" in message.channel
      ? message.channel.name
      : "default";
  const sessionId = channelSessions.get(channelId);

  console.log(`Received message in channel: ${channelName} (${channelId})`);
  console.log(`Message content: ${message.content}`);
  console.log(`Existing session ID: ${sessionId || "none"}`);

  try {
    // Create initial Discord message
    const reply = await message.channel.send("Starting Claude Code session...");
    channelMessages.set(channelId, reply);
    channelResponses.set(channelId, []);

    // Kill any existing process (safety measure)
    const existingProcess = channelProcesses.get(channelId);
    if (existingProcess?.process) {
      console.log(
        `Killing existing process for channel ${channelId} before starting new one`
      );
      existingProcess.process.kill("SIGTERM");
    }

    // Reserve the channel by adding a placeholder entry (prevents race conditions)
    channelProcesses.set(channelId, {
      process: null, // Will be set when process actually starts
      sessionId,
      discordMessage: reply,
    });

    // Run Claude Code
    await runClaudeCode(channelId, channelName, message.content, sessionId);
  } catch (error) {
    console.error("Error running Claude Code:", error);

    // Clean up on error
    channelProcesses.delete(channelId);

    const reply = channelMessages.get(channelId);
    if (reply) {
      await reply.edit(
        `Error: ${error instanceof Error ? error.message : String(error)}`
      );
    } else {
      await message.channel.send(
        `Error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
});

const token = process.env.DISCORD_TOKEN;
const allowedUserId = process.env.ALLOWED_USER_ID;
const baseFolder = process.env.BASE_FOLDER;

if (!token) {
  console.error("DISCORD_TOKEN environment variable is required");
  process.exit(1);
}

if (!allowedUserId) {
  console.error("ALLOWED_USER_ID environment variable is required");
  process.exit(1);
}

if (!baseFolder) {
  console.error("BASE_FOLDER environment variable is required");
  process.exit(1);
}

client.login(token).catch(console.error);
