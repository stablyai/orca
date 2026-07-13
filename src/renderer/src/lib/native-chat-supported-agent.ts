import type { AgentType } from '../../../shared/agent-status-types'
import type { TuiAgent } from '../../../shared/types'

/** Agents whose transcripts the native chat view can parse and render. */
export const NATIVE_CHAT_SUPPORTED_AGENTS: ReadonlySet<string> = new Set<string>([
  'claude',
  'openclaude',
  'codex',
  // Why: Grok writes `~/.grok/sessions/<cwd-enc>/<id>/chat_history.jsonl` and
  // Orca already reads that for hooks/AI Vault — native chat reuses the same
  // path + a Grok JSONL decoder rather than leaving Grok TUI-only.
  'grok'
])

export function isNativeChatSupportedAgent(
  agent: TuiAgent | AgentType | null | undefined
): boolean {
  return agent != null && NATIVE_CHAT_SUPPORTED_AGENTS.has(agent)
}
