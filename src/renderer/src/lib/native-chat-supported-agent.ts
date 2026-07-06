import type { AgentType } from '../../../shared/agent-status-types'
import type { TuiAgent } from '../../../shared/types'

/** Agents whose transcripts the native chat view can parse and render. */
export const NATIVE_CHAT_SUPPORTED_AGENTS: ReadonlySet<string> = new Set<string>([
  'claude',
  'openclaude',
  'codex'
])

export function isNativeChatSupportedAgent(
  agent: TuiAgent | AgentType | null | undefined
): boolean {
  return agent != null && NATIVE_CHAT_SUPPORTED_AGENTS.has(agent)
}
