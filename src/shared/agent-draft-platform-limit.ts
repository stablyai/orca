import type { AgentStartupShell } from './tui-agent-startup-shell'

const WIN32_INLINE_DRAFT_LIMIT_CHARS = 24_000
const WIN32_CMD_INLINE_DRAFT_LIMIT_CHARS = 7_500

export function inlineAgentDraftFitsPlatform(args: {
  command: string
  env?: Record<string, string>
  platform: NodeJS.Platform
  shell?: AgentStartupShell
}): boolean {
  if (args.platform !== 'win32') {
    return true
  }
  const envChars = Object.entries(args.env ?? {}).reduce(
    (total, [key, value]) => total + key.length + value.length,
    0
  )
  // Why: cmd.exe caps command lines at 8191 chars; other Windows launch paths
  // still need headroom for CreateProcess and its environment block.
  const limit =
    args.shell === 'cmd' ? WIN32_CMD_INLINE_DRAFT_LIMIT_CHARS : WIN32_INLINE_DRAFT_LIMIT_CHARS
  return args.command.length + envChars <= limit
}
