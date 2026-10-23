import type { TuiAgent } from './tui-agent'

export type NativeChatTranscriptAgent = 'claude' | 'codex' | 'grok' | 'omp' | 'opencode'

/** Agents whose transcripts the native chat view can parse and render. */
export const NATIVE_CHAT_SUPPORTED_AGENT_LIST: readonly TuiAgent[] = [
  'claude',
  'openclaude',
  'codex',
  'grok',
  'omp',
  'opencode',
  'opencode2',
  'zcode',
  'qoder',
  'qoder-cn'
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
    transcriptAgent === 'claude' || transcriptAgent === 'codex' || transcriptAgent === 'opencode'
  )
}

/** OMP's configurable keys and existing checkbox state cannot be replaced through PTY input. */
export function nativeChatAskRequiresTerminal(agent: string | null | undefined): boolean {
  return resolveNativeChatTranscriptAgent(agent) === 'omp'
}

/** Qoder CLI and its China build, which share one transcript format and TUI. */
export function isQoderNativeChatAgent(agent: string | null | undefined): boolean {
  return agent === 'qoder' || agent === 'qoder-cn'
}

export function resolveNativeChatTranscriptAgent(
  agent: string | null | undefined
): NativeChatTranscriptAgent | null {
  // Why: OpenClaude and Qoder write the Claude transcript format even though Orca
  // preserves their distinct agent identity for launch and UI behavior.
  if (agent === 'claude' || agent === 'openclaude' || isQoderNativeChatAgent(agent)) {
    return 'claude'
  }
  if (agent === 'opencode' || agent === 'opencode2' || agent === 'zcode') {
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
