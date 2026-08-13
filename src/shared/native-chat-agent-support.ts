export type NativeChatTranscriptAgent = 'claude' | 'codex' | 'droid' | 'grok' | 'omp'

/** Agents whose transcripts the native chat view can parse and render. */
export const NATIVE_CHAT_SUPPORTED_AGENTS: ReadonlySet<string> = new Set([
  'claude',
  'openclaude',
  'codex',
  'droid',
  'grok',
  'omp'
])

export function isNativeChatSupportedAgent(agent: string | null | undefined): boolean {
  return agent != null && NATIVE_CHAT_SUPPORTED_AGENTS.has(agent)
}

/** Agents whose hook discloses no transcript path (`extractAgentProviderSession`),
 *  so native chat can only reach the session file by scanning a sessions root on
 *  a disk THIS process can read. Under Model-A SSH that disk is the wrong host,
 *  so the chat view must stay closed instead of loading forever. */
export function nativeChatRequiresLocalTranscript(agent: string | null | undefined): boolean {
  const transcriptAgent = resolveNativeChatTranscriptAgent(agent)
  return transcriptAgent === 'grok' || transcriptAgent === 'omp' || transcriptAgent === 'droid'
}

/** True when the agent renders a selector that ignores typed label text (pasting
 *  "Blue" + Enter commits the highlighted FIRST option — STA-1860), so answers
 *  must be delivered as navigation keystrokes: Claude's AskUserQuestion, Codex
 *  0.145's request_user_input, and Droid's AskUser (arrow-navigated, with no
 *  option digits at all). Other agents commit a pasted answer. */
export function shouldStepNativeChatAskAnswer(agent: string | null | undefined): boolean {
  const transcriptAgent = resolveNativeChatTranscriptAgent(agent)
  return transcriptAgent === 'claude' || transcriptAgent === 'codex' || transcriptAgent === 'droid'
}

export function resolveNativeChatTranscriptAgent(
  agent: string | null | undefined
): NativeChatTranscriptAgent | null {
  // Why: OpenClaude writes the Claude transcript format and layout even though
  // Orca preserves its distinct agent identity for launch and UI behavior.
  if (agent === 'claude' || agent === 'openclaude') {
    return 'claude'
  }
  if (agent === 'codex' || agent === 'droid' || agent === 'grok' || agent === 'omp') {
    return agent
  }
  return null
}
