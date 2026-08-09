export type NativeChatTranscriptAgent = 'claude' | 'codex' | 'grok' | 'omp' | 'opencode'

/** Agents whose transcripts the native chat view can parse and render. */
export const NATIVE_CHAT_SUPPORTED_AGENTS: ReadonlySet<string> = new Set([
  'claude',
  'openclaude',
  'codex',
  'grok',
  'omp',
  'opencode'
])

export function isNativeChatSupportedAgent(agent: string | null | undefined): boolean {
  return agent != null && NATIVE_CHAT_SUPPORTED_AGENTS.has(agent)
}

/** Agents whose native-chat reader opens transcript storage on the serving host.
 *  Model-A SSH has no runtime RPC reader, so every supported agent must be
 *  backed by storage on the local process's host before chat can open. */
export function nativeChatRequiresHostReadableTranscript(
  agent: string | null | undefined
): boolean {
  return resolveNativeChatTranscriptAgent(agent) !== null
}

/** Agents whose hook does not disclose a direct transcript path. */
export function nativeChatRequiresLocalTranscript(agent: string | null | undefined): boolean {
  const transcriptAgent = resolveNativeChatTranscriptAgent(agent)
  return (
    transcriptAgent === 'grok' ||
    transcriptAgent === 'omp' ||
    transcriptAgent === 'opencode'
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
  if (agent === 'codex' || agent === 'grok' || agent === 'omp' || agent === 'opencode') {
    return agent
  }
  return null
}
