# Claude Code Discord Bot

A Discord bot that runs Claude Code sessions on different projects based on Discord channel names. Each channel maps to a folder in your file system, allowing you to interact with Claude Code for different repositories through Discord.

## Features

- **Channel-based project mapping**: Each Discord channel corresponds to a folder (e.g., `#my-project` → `/path/to/repos/my-project`)
- **Persistent sessions**: Sessions are maintained per channel and automatically resume
- **Real-time streaming**: See Claude Code's tool usage and responses as they happen
- **Activity logging**: Shows up to 20 lines of activity including tool calls with parameters
- **Slash commands**: Use `/clear` to reset a session

## Prerequisites

- [Bun](https://bun.sh/) installed on your system
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and configured
- A Discord account and server where you have administrative permissions

## Setup Instructions

### 1. Create a Discord Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application"
3. Give your application a name (e.g., "Claude Code Bot")
4. Click "Create"

### 2. Create a Bot User

1. In your application, go to the "Bot" section in the left sidebar
2. Click "Add Bot"
3. Under "Token", click "Copy" to copy your bot token (keep this secure!)
4. Under "Privileged Gateway Intents", enable:
   - Message Content Intent
5. Click "Save Changes"

### 3. Invite the Bot to Your Server

1. Go to the "OAuth2" → "URL Generator" section
2. Under "Scopes", select:
   - `bot`
   - `applications.commands`
3. Under "Bot Permissions", select:
   - Send Messages
   - Use Slash Commands
   - Read Message History
   - Embed Links
4. Copy the generated URL and open it in your browser
5. Select your Discord server and authorize the bot

### 4. Get Your Discord User ID

1. Enable Developer Mode in Discord:
   - Go to Discord Settings → Advanced → Enable "Developer Mode"
2. Right-click on your username in any channel
3. Click "Copy User ID"
4. Save this ID - you'll need it for the configuration

### 5. Clone and Setup the Bot

```bash
# Clone the repository
git clone <repository-url>
cd claude-code-discord

# Install dependencies
bun install
```

### 6. Configure Environment Variables

Create a `.env` file in the project root:

```env
# Discord bot token from step 2
DISCORD_TOKEN=your_discord_bot_token_here

# Your Discord user ID from step 4
ALLOWED_USER_ID=your_discord_user_id_here

# Base folder containing your repositories
# Each Discord channel will map to a subfolder here
# Example: if BASE_FOLDER=/Users/you/repos and channel is #my-project
# The bot will operate in /Users/you/repos/my-project
BASE_FOLDER=/path/to/your/repos
```

### 7. Prepare Your Repository Structure

Organize your repositories under the base folder with names matching your Discord channels:

```
/path/to/your/repos/
├── my-project/          # Maps to #my-project channel
├── another-repo/        # Maps to #another-repo channel
├── test-app/           # Maps to #test-app channel
└── experimental/       # Maps to #experimental channel
```

**Important**: Channel names in Discord should match folder names exactly (Discord will convert spaces to hyphens).

### 8. Create Discord Channels

In your Discord server, create channels for each repository:
- `#my-project`
- `#another-repo` 
- `#test-app`
- `#experimental`

### 9. Run the Bot

```bash
# Start the bot
bun run src/index.ts

# Or use the npm script
bun start
```

**Important**: Do not use hot reload (`bun --hot`) as it can cause issues with process management and spawn multiple Claude processes.

You should see:
```
Bot is ready! Logged in as Claude Code Bot#1234
Successfully registered application commands.
```

## Usage

### Basic Usage

1. Go to any channel that corresponds to a repository folder
2. Type any message - this will prompt Claude Code with your message
3. The bot will create a "Starting Claude Code session..." message
4. Watch as the message updates with Claude's tool usage and responses
5. See the final completion status when done

### Commands

- **Any message**: Runs Claude Code with your message as the prompt
- **/clear**: Resets the current channel's session (starts fresh next time)

### Example Interaction

```
You: hello
Bot: 🔧 LS (path: .)
     🔧 Read (file_path: ./package.json)
     🔧 Read (file_path: ./README.md)
     Hello! I can see this is a Node.js project. What would you like to work on?
     ✅ Completed (3 turns)
```

## How It Works

- **Channel Mapping**: `#my-project` channel → `/path/to/repos/my-project` folder
- **Session Persistence**: Each channel maintains its own Claude Code session
- **Activity Logging**: Shows up to 20 lines of activity with FIFO behavior
- **Tool Visibility**: See exactly what tools Claude is using and with what parameters
- **Path Simplification**: Full paths are shortened to relative paths (e.g., `./index.ts` instead of `/full/path/to/index.ts`)

## Security Notes

- **Private Server Recommended**: Use a private Discord server for your repositories to avoid exposing project details
- **User Restriction**: Only the configured `ALLOWED_USER_ID` can interact with the bot
- **Environment Variables**: Keep your `.env` file secure and never commit it to version control
- **Bot Token**: Keep your Discord bot token secure - treat it like a password

## Troubleshooting

### Bot doesn't respond
- Check that the bot has proper permissions in the channel
- Verify your `ALLOWED_USER_ID` is correct
- Check the console for error messages

### "Working directory does not exist" error
- Ensure the folder exists: `/path/to/repos/channel-name`
- Check that `BASE_FOLDER` in `.env` is correct
- Verify folder names match Discord channel names exactly

### Session not persisting
- Sessions are stored in memory and reset when the bot restarts
- Use `/clear` if you want to intentionally reset a session

### Rate limiting
- Discord has rate limits for message editing
- The bot handles this automatically, but very rapid Claude responses might be delayed

## Development

This project uses:
- **Bun** as the JavaScript runtime
- **TypeScript** with strict type checking
- **discord.js** for Discord API interaction
- **Claude Code CLI** for AI interactions

To modify the code:
```bash
# Install dependencies
bun install

# Run during development (restart manually after changes)
bun start

# Run tests
bun test
```

**Note**: Hot reload is not recommended for this bot as it can cause process management issues and spawn multiple Claude processes.

## License

This project is licensed under the MIT License.