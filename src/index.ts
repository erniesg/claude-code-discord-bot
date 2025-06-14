import { DiscordBot } from './bot/client.js';
import { ClaudeManager } from './claude/manager.js';
import { validateConfig } from './utils/config.js';

async function main() {
  const config = validateConfig();
  
  const claudeManager = new ClaudeManager(config.baseFolder);
  const bot = new DiscordBot(claudeManager, config.allowedUserId);
  
  await bot.login(config.discordToken);
}

main().catch(console.error);