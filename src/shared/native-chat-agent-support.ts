export type NativeChatTranscriptAgent = 'claude' | 'codex' | 'grok'

/** Agents that expose an Agent Client Protocol server instead of writing a
 *  JSONL transcript. `hermes` serves ACP via `hermes acp` (acp_adapter, protocol
 *  v1); `omp` via `omp acp`. Both report loadSession + session fork/list/resume,
 *  so native chat drives them live over stdio rather than tailing a file. */
export type NativeChatAcpAgent = 'hermes' | 'omp'

/** How native chat obtains an agent's conversation. `transcript` tails the
 *  agent's own JSONL on disk; `acp` drives a JSON-RPC session over stdio. */
export type NativeChatTransport = 'transcript' | 'acp'

export const NATIVE_CHAT_ACP_AGENTS: ReadonlySet<string> = new Set(['hermes', 'omp'])

/** Agents whose conversation the native chat view can render — the transcript
 *  agents by parsing their JSONL, the ACP agents by driving a live session.
 *
 *  This set is the UI availability gate: every consumer
 *  (native-chat-availability, native-chat-initial-view-mode,
 *  mobile-native-chat-eligibility) offers the chat toggle for anything listed
 *  here, so an entry must have a working transport in source-dispatch.ts. */
export const NATIVE_CHAT_SUPPORTED_AGENTS: ReadonlySet<string> = new Set([
  'claude',
  'openclaude',
  'codex',
  'grok',
  // ACP transport (source-dispatch.ts -> acp-source.ts). `omp` is the agent type
  // omherm presents as; there is no separate `omherm` type.
  'hermes',
  'omp'
])

export function isNativeChatSupportedAgent(agent: string | null | undefined): boolean {
  return agent != null && NATIVE_CHAT_SUPPORTED_AGENTS.has(agent)
}

export function resolveNativeChatAcpAgent(
  agent: string | null | undefined
): NativeChatAcpAgent | null {
  return agent === 'hermes' || agent === 'omp' ? agent : null
}

/** Resolve which transport carries this agent's conversation, or null when the
 *  agent is unsupported. Transcript is checked first so an agent that somehow
 *  appears in both sets keeps its existing file-based behavior. */
export function resolveNativeChatTransport(
  agent: string | null | undefined
): NativeChatTransport | null {
  if (resolveNativeChatTranscriptAgent(agent) != null) {
    return 'transcript'
  }
  return resolveNativeChatAcpAgent(agent) != null ? 'acp' : null
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
  if (agent === 'codex' || agent === 'grok') {
    return agent
  }
  return null
}
