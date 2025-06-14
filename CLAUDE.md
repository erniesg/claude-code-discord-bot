# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Runtime and Package Management

This project uses **Bun** as the JavaScript runtime instead of Node.js. Always use Bun commands:

- `bun install` - Install dependencies
- `bun run index.ts` - Run the main application
- `bun --hot ./index.ts` - Run with hot reload for development
- `bun run test` - Run tests (instead of jest/vitest)
- `bun build <file>` - Build files (instead of webpack/esbuild)

## Architecture

This is a TypeScript project with strict type checking enabled. The project structure is minimal:
- `src/index.ts` - Main entry point
- TypeScript configuration uses modern ES features (ESNext) with bundler module resolution

## Bun-Specific APIs

When adding functionality, prefer Bun's built-in APIs:
- `Bun.serve()` for HTTP servers with WebSocket support (instead of Express)
- `bun:sqlite` for SQLite (instead of better-sqlite3)
- `Bun.redis` for Redis (instead of ioredis)  
- `Bun.sql` for Postgres (instead of pg)
- Built-in `WebSocket` (instead of ws library)
- `Bun.$`command`` for shell commands (instead of execa)

## Frontend Development

If adding frontend features, use HTML imports with `Bun.serve()`:
- HTML files can directly import .tsx/.jsx/.js files
- CSS files can be imported directly in components
- Bun handles transpilation and bundling automatically
- Use `development: { hmr: true }` for hot module replacement

## Discord Bot Functionality

This bot runs Claude Code sessions on different projects based on Discord channel names:

- Each Discord channel maps to a folder: `BASE_FOLDER/channel-name`
- Sessions persist per channel with automatic resume using session IDs
- Only responds to messages from the configured `ALLOWED_USER_ID`
- Streams Claude Code output and updates Discord messages in real-time
- Shows the last 3 streamed responses in each message
- Use `/clear` slash command to reset a session

### Commands
- Any message in a channel runs Claude Code with that prompt
- `/clear` - Reset the current session (starts fresh next time)

## Environment Variables

Required environment variables:
- `DISCORD_TOKEN` - Bot token from Discord Developer Portal
- `ALLOWED_USER_ID` - Discord user ID who can use the bot
- `BASE_FOLDER` - Base path where Claude Code operates (e.g., `/Users/tim/repos`)

## Environment

- Bun automatically loads .env files (no need for dotenv)
- TypeScript is configured with strict mode and modern features
- No emit compilation (bundler handles this)

## Important Restrictions

- Never run the bot. You are not allowed to use the `bun run src/index.ts` command. 
- You can run tests, but never run the main application.

## Testing Notes

- Use `bun run test` to run tests. Never use just `bun test`