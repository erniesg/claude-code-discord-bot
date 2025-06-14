export function escapeShellString(str: string): string {
  // Replace ' with '\'' and wrap in single quotes
  return `'${str.replace(/'/g, "'\\''")}'`;
}

export function buildClaudeCommand(
  workingDir: string,
  prompt: string,
  sessionId?: string
): string {
  const escapedPrompt = escapeShellString(prompt);
  
  const commandParts = [
    `cd ${workingDir}`,
    "&&",
    "claude",
    "--output-format",
    "stream-json",
    "--model",
    "sonnet",
    "-p",
    escapedPrompt,
    "--verbose",
  ];

  if (sessionId) {
    commandParts.splice(3, 0, "--resume", sessionId);
  }

  return commandParts.join(" ");
}