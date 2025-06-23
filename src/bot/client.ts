import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
} from "discord.js";
import type { ClaudeManager } from '../claude/manager.js';
import { CommandHandler } from './commands.js';
import type { MCPPermissionServer } from '../mcp/server.js';
import { AudioTranscriptionService } from '../services/audio-transcription.js';

export class DiscordBot {
  public client: Client; // Make public so MCP server can access it
  private commandHandler: CommandHandler;
  private mcpServer?: MCPPermissionServer;
  private audioTranscription: AudioTranscriptionService;

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
    this.audioTranscription = new AudioTranscriptionService();
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
    
    // Check if this is an audio message
    let messageContent = message.content;
    if (this.audioTranscription.isAudioMessage(message)) {
      console.log("Audio message detected, starting transcription...");
      
      try {
        // Send initial processing message
        const processingEmbed = new EmbedBuilder()
          .setTitle("🎤 Processing Audio")
          .setDescription("Transcribing your voice message...")
          .setColor(0x0099FF);
        
        const processingMessage = await message.channel.send({ embeds: [processingEmbed] });
        
        // Transcribe the audio
        const transcription = await this.audioTranscription.processAudioMessage(message);
        
        // Update the processing message with transcription
        const transcribedEmbed = new EmbedBuilder()
          .setTitle("🎤 Audio Transcribed")
          .setDescription(`**Transcription:** ${transcription}`)
          .setColor(0x00FF00);
        
        await processingMessage.edit({ embeds: [transcribedEmbed] });
        
        // Use transcription as message content
        messageContent = transcription;
        console.log(`Transcribed audio: ${transcription}`);
        
      } catch (error) {
        console.error("Audio transcription failed:", error);
        
        const errorEmbed = new EmbedBuilder()
          .setTitle("❌ Transcription Failed")
          .setDescription(`Failed to transcribe audio: ${error instanceof Error ? error.message : 'Unknown error'}`)
          .setColor(0xFF0000);
        
        await message.channel.send({ embeds: [errorEmbed] });
        return;
      }
    }
    
    // If no text content and no transcription, skip
    if (!messageContent || messageContent.trim() === '') {
      console.log("No text content to process");
      return;
    }
    
    console.log(`Message content: ${messageContent}`);
    console.log(`Existing session ID: ${sessionId || "none"}`);

    try {
      // Check if we have an existing session
      const isNewSession = !sessionId;
      
      // Create status embed
      const statusEmbed = new EmbedBuilder()
        .setColor(0xFFD700); // Yellow for startup
      
      if (isNewSession) {
        statusEmbed
          .setTitle("🆕 Starting New Session")
          .setDescription("Initializing Claude Code...");
      } else {
        statusEmbed
          .setTitle("🔄 Continuing Session")
          .setDescription(`**Session ID:** ${sessionId}\nResuming Claude Code...`);
      }
      
      // Create initial Discord message
      const reply = await message.channel.send({ embeds: [statusEmbed] });
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
      await this.claudeManager.runClaudeCode(channelId, channelName, messageContent, sessionId, discordContext);
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