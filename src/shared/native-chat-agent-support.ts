import type { TuiAgent } from './tui-agent'

export type NativeChatTranscriptAgent = 'claude' | 'codex' | 'grok' | 'omp' | 'opencode'

/** Agents whose transcripts the native chat view can parse and render, in the
 *  order the settings pane advertises them. */
export const NATIVE_CHAT_SUPPORTED_AGENT_LIST: readonly TuiAgent[] = [
  'claude',
  'openclaude',
  'codex',
  'grok',
  'omp',
  'opencode',
  'opencode2'
]

export const NATIVE_CHAT_SUPPORTED_AGENTS: ReadonlySet<string> = new Set(
  NATIVE_CHAT_SUPPORTED_AGENT_LIST
)

export function isNativeChatSupportedAgent(agent: string | null | undefined): boolean {
  return agent != null && NATIVE_CHAT_SUPPORTED_AGENTS.has(agent)
}

/** Agents whose Model-A SSH transcript reader is not supported. A hook path alone
 *  does not establish owning-host reads, so OMP remains gated even with metadata. */
export function nativeChatRequiresLocalTranscript(agent: string | null | undefined): boolean {
  const transcriptAgent = resolveNativeChatTranscriptAgent(agent)
  return transcriptAgent === 'grok' || transcriptAgent === 'omp' || transcriptAgent === 'opencode'
}

/** Selector TUIs require key steps rather than pasted option labels. */
export function shouldStepNativeChatAskAnswer(agent: string | null | undefined): boolean {
  const transcriptAgent = resolveNativeChatTranscriptAgent(agent)
  return (
    transcriptAgent === 'claude' ||
    transcriptAgent === 'codex' ||
    transcriptAgent === 'opencode' ||
    transcriptAgent === 'omp'
  )
}

export function resolveNativeChatTranscriptAgent(
  agent: string | null | undefined
): NativeChatTranscriptAgent | null {
  // Why: OpenClaude writes the Claude transcript format and layout even though
  // Orca preserves its distinct agent identity for launch and UI behavior.
  if (agent === 'claude' || agent === 'openclaude') {
    return 'claude'
  }
  if (agent === 'opencode' || agent === 'opencode2') {
    return 'opencode'
  }
  if (agent === 'codex' || agent === 'grok' || agent === 'omp') {
    return agent
  }
  return null
}

export function nativeChatApprovalAcceptKey(agent: string | null | undefined): string {
  return resolveNativeChatTranscriptAgent(agent) === 'opencode' ? '\r' : '1'
}
