const SHELL_COMMAND_PREFIX = '!'

/**
 * The shell command a `!` draft asks to run, as Claude Code's terminal bash mode reads it, or null
 * for any other draft. Structured chats have no TUI to run it, so Orca runs it in a terminal.
 */
export function nativeChatShellCommand(draft: string): string | null {
  const trimmed = draft.trim()
  if (!trimmed.startsWith(SHELL_COMMAND_PREFIX)) {
    return null
  }
  const command = trimmed.slice(SHELL_COMMAND_PREFIX.length).trim()
  return command === '' ? null : command
}
