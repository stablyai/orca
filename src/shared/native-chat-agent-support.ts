import type { TuiAgent } from './tui-agent'

export type NativeChatTranscriptAgent = 'claude' | 'codex' | 'grok' | 'omp' | 'antigravity'

/** Agents whose transcripts the native chat view can parse and render, in the
 *  order the settings pane advertises them. */
export const NATIVE_CHAT_SUPPORTED_AGENT_LIST: readonly TuiAgent[] = [
  'claude',
  'openclaude',
  'codex',
  'grok',
  'omp',
  'antigravity'
]

export const NATIVE_CHAT_SUPPORTED_AGENTS: ReadonlySet<string> = new Set(
  NATIVE_CHAT_SUPPORTED_AGENT_LIST
)

export function isNativeChatSupportedAgent(agent: string | null | undefined): boolean {
  return agent != null && NATIVE_CHAT_SUPPORTED_AGENTS.has(agent)
}

/** Agents whose chat reads require a filesystem owned by the selected runtime.
 * Direct SSH has no transcript transport; a hook path alone is not a local file. */
export function nativeChatRequiresLocalTranscript(agent: string | null | undefined): boolean {
  const transcriptAgent = resolveNativeChatTranscriptAgent(agent)
  return (
    transcriptAgent === 'grok' || transcriptAgent === 'omp' || transcriptAgent === 'antigravity'
  )
}

/** True when the agent renders a digit-commit question selector that ignores
 *  typed label text (pasting "Blue" + Enter commits the highlighted FIRST
 *  option — STA-1860): Claude's AskUserQuestion and Codex 0.145's
 *  request_user_input card both behave this way, so answers must be delivered
 *  as per-option keystrokes. Other agents commit a pasted answer. */
export function shouldStepNativeChatAskAnswer(agent: string | null | undefined): boolean {
  const transcriptAgent = resolveNativeChatTranscriptAgent(agent)
  return transcriptAgent === 'claude' || transcriptAgent === 'codex'
}

export function resolveNativeChatTranscriptAgent(
  agent: string | null | undefined
): NativeChatTranscriptAgent | null {
  // Why: OpenClaude writes the Claude transcript format and layout even though
  // Orca preserves its distinct agent identity for launch and UI behavior.
  if (agent === 'claude' || agent === 'openclaude') {
    return 'claude'
  }
  if (agent === 'codex' || agent === 'grok' || agent === 'omp' || agent === 'antigravity') {
    return agent
  }
  return null
}
