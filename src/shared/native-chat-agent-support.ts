import {
  buildAskAnswerKeys,
  buildCodexAskAnswerKeys,
  type AskAnswerKeyGroup,
  type AskAnswerSelection,
  type AskPrompt
} from './native-chat-ask'
import { buildGrokAskAnswerKeys } from './native-chat-grok-ask-answer'
import type { TuiAgent } from './tui-agent'

export type NativeChatTranscriptAgent = 'claude' | 'codex' | 'grok' | 'omp'

export type NativeChatAskAnswerBuilder = (
  prompt: AskPrompt,
  selections: AskAnswerSelection[]
) => AskAnswerKeyGroup[]

const NATIVE_CHAT_ASK_ANSWER_BUILDERS: Partial<
  Record<NativeChatTranscriptAgent, NativeChatAskAnswerBuilder>
> = {
  claude: buildAskAnswerKeys,
  codex: buildCodexAskAnswerKeys,
  grok: buildGrokAskAnswerKeys
}

/** Agents whose transcripts the native chat view can parse and render, in the
 *  order the settings pane advertises them. */
export const NATIVE_CHAT_SUPPORTED_AGENT_LIST: readonly TuiAgent[] = [
  'claude',
  'openclaude',
  'codex',
  'grok',
  'omp'
]

export const NATIVE_CHAT_SUPPORTED_AGENTS: ReadonlySet<string> = new Set(
  NATIVE_CHAT_SUPPORTED_AGENT_LIST
)

export function isNativeChatSupportedAgent(agent: string | null | undefined): boolean {
  return agent != null && NATIVE_CHAT_SUPPORTED_AGENTS.has(agent)
}

/** Agents whose hook discloses no transcript path (`extractAgentProviderSession`),
 *  so native chat can only reach the session file by scanning a sessions root on
 *  a disk THIS process can read. Under Model-A SSH that disk is the wrong host,
 *  so the chat view must stay closed instead of loading forever. */
export function nativeChatRequiresLocalTranscript(agent: string | null | undefined): boolean {
  const transcriptAgent = resolveNativeChatTranscriptAgent(agent)
  return transcriptAgent === 'grok' || transcriptAgent === 'omp'
}

/** True when the agent renders a digit-commit question selector that ignores
 *  typed label text (pasting "Blue" + Enter commits the highlighted FIRST
 *  option — STA-1860): Claude's AskUserQuestion, Codex 0.145's
 *  request_user_input, and Grok's ask_user_question cards behave this way,
 *  so answers must be delivered as per-option keystrokes. Other agents commit
 *  a pasted answer. */
export function shouldStepNativeChatAskAnswer(agent: string | null | undefined): boolean {
  return resolveNativeChatAskAnswerBuilder(agent) !== null
}

/** Returns the selector strategy registered for an agent's transcript format. */
export function resolveNativeChatAskAnswerBuilder(
  agent: string | null | undefined
): NativeChatAskAnswerBuilder | null {
  const transcriptAgent = resolveNativeChatTranscriptAgent(agent)
  return transcriptAgent ? (NATIVE_CHAT_ASK_ANSWER_BUILDERS[transcriptAgent] ?? null) : null
}

export function resolveNativeChatTranscriptAgent(
  agent: string | null | undefined
): NativeChatTranscriptAgent | null {
  // Why: OpenClaude writes the Claude transcript format and layout even though
  // Orca preserves its distinct agent identity for launch and UI behavior.
  if (agent === 'claude' || agent === 'openclaude') {
    return 'claude'
  }
  if (agent === 'codex' || agent === 'grok' || agent === 'omp') {
    return agent
  }
  return null
}
