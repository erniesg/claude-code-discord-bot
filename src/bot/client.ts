import {
  Client,
  GatewayIntentBits,
} from "discord.js";
import type { ClaudeManager } from '../claude/manager.js';
import { CommandHandler } from './commands.js';

export class DiscordBot {
  private client: Client;
  private commandHandler: CommandHandler;

  constructor(
    private claudeManager: ClaudeManager,
    private allowedUserId: string
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.commandHandler = new CommandHandler(claudeManager, allowedUserId);
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.once("ready", async () => {
      console.log(`Bot is ready! Logged in as ${this.client.user?.tag}`);
      await this.commandHandler.registerCommands(
        process.env.DISCORD_TOKEN!,
        this.client.user!.id
      );
    });

    this.client.on("interactionCreate", async (interaction) => {
      await this.commandHandler.handleInteraction(interaction);
    });

    this.client.on("messageCreate", async (message) => {
      await this.handleMessage(message);
    });
  }

  private async handleMessage(message: any): Promise<void> {
    if (message.author.bot) return;

    console.log("MESSAGE CREATED", message.id);

    if (message.author.id !== this.allowedUserId) {
      return;
    }

    const channelId = message.channelId;

    // Atomic check-and-lock: if channel is already processing, skip
    if (this.claudeManager.hasActiveProcess(channelId)) {
      console.log(
        `Channel ${channelId} is already processing, skipping new message`
      );
      return;
    }

    const channelName =
      message.channel && "name" in message.channel
        ? message.channel.name
        : "default";
    const sessionId = this.claudeManager.getSessionId(channelId);

    console.log(`Received message in channel: ${channelName} (${channelId})`);
    console.log(`Message content: ${message.content}`);
    console.log(`Existing session ID: ${sessionId || "none"}`);

    try {
      // Create initial Discord message
      const reply = await message.channel.send("Starting Claude Code session...");
      console.log("Created Discord message:", reply.id);
      this.claudeManager.setDiscordMessage(channelId, reply);

      // Reserve the channel and run Claude Code
      this.claudeManager.reserveChannel(channelId, sessionId, reply);
      await this.claudeManager.runClaudeCode(channelId, channelName, message.content, sessionId);
    } catch (error) {
      console.error("Error running Claude Code:", error);
      
      // Clean up on error
      this.claudeManager.clearSession(channelId);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      try {
        await message.channel.send(`Error: ${errorMessage}`);
      } catch (sendError) {
        console.error("Failed to send error message:", sendError);
      }
    }
  }

  async login(token: string): Promise<void> {
    await this.client.login(token);
  }
}