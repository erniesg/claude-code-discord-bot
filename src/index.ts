import { DiscordBot } from './bot/client.js';
import { ClaudeManager } from './claude/manager.js';
import { validateConfig } from './utils/config.js';

async function main() {
  const config = validateConfig();
  
  const claudeManager = new ClaudeManager(config.baseFolder);
  const bot = new DiscordBot(claudeManager, config.allowedUserId);
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully...');
    claudeManager.destroy();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    claudeManager.destroy();
    process.exit(0);
  });
  
  await bot.login(config.discordToken);
}

main().catch(console.error);