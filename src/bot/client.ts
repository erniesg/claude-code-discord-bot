import {
  Client,
  GatewayIntentBits,
} from "discord.js";
import type { ClaudeManager } from '../claude/manager.js';
import { CommandHandler } from './commands.js';
import type { MCPPermissionServer } from '../mcp/server.js';

export class DiscordBot {
  public client: Client; // Make public so MCP server can access it
  private commandHandler: CommandHandler;
  private mcpServer?: MCPPermissionServer;

  constructor(
    private claudeManager: ClaudeManager,
    private allowedUserId: string
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions, // Add reactions for approval
      ],
    });

    this.commandHandler = new CommandHandler(claudeManager, allowedUserId);
    this.setupEventHandlers();
  }

  /**
   * Set the MCP server for handling approval reactions
   */
  setMCPServer(mcpServer: MCPPermissionServer): void {
    this.mcpServer = mcpServer;
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

    // Handle reactions for MCP approval
    this.client.on("messageReactionAdd", async (reaction, user) => {
      await this.handleReactionAdd(reaction, user);
    });
  }

  /**
   * Handle reaction add events for MCP approval
   */
  private async handleReactionAdd(reaction: any, user: any): Promise<void> {
    // Ignore bot reactions
    if (user.bot) return;

    // Only process reactions from the authorized user
    if (user.id !== this.allowedUserId) return;

    // Only process ✅ and ❌ reactions
    if (reaction.emoji.name !== '✅' && reaction.emoji.name !== '❌') return;

    console.log(`Discord: Reaction ${reaction.emoji.name} by ${user.id} on message ${reaction.message.id}`);

    // Pass to MCP server if available
    if (this.mcpServer) {
      const approved = reaction.emoji.name === '✅';
      this.mcpServer.getPermissionManager().handleApprovalReaction(
        reaction.message.channelId,
        reaction.message.id,
        user.id,
        approved
      );
    }
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
    
    // Don't run in general channel
    if (channelName === "general") {
      return;
    }
    
    const sessionId = this.claudeManager.getSessionId(channelId);

    console.log(`Received message in channel: ${channelName} (${channelId})`);
    console.log(`Message content: ${message.content}`);
    console.log(`Existing session ID: ${sessionId || "none"}`);

    try {
      // Check if we have an existing session
      const isNewSession = !sessionId;
      const statusMessage = isNewSession 
        ? "🆕 Starting new Claude Code session..." 
        : "🔄 Continuing existing Claude Code session...";
      
      // Create initial Discord message
      const reply = await message.channel.send(statusMessage);
      console.log("Created Discord message:", reply.id);
      this.claudeManager.setDiscordMessage(channelId, reply);

      // Create Discord context for MCP server
      const discordContext = {
        channelId: channelId,
        channelName: channelName,
        userId: message.author.id,
        messageId: message.id,
      };

      // Reserve the channel and run Claude Code
      this.claudeManager.reserveChannel(channelId, sessionId, reply);
      await this.claudeManager.runClaudeCode(channelId, channelName, message.content, sessionId, discordContext);
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