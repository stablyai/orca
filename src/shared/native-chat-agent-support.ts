import {
  NATIVE_CHAT_AGENT_ADAPTERS,
  type NativeChatTranscriptAgent
} from './native-chat-agent-adapters'

export type { NativeChatTranscriptAgent } from './native-chat-agent-adapters'

/** Projects a registry descriptor to its supported-agent identity. */
function nativeChatAgentId({ agent }: { agent: string }): string {
  return agent
}

/** Agents whose transcripts the native chat view can parse and render. */
export const NATIVE_CHAT_SUPPORTED_AGENTS: ReadonlySet<string> = new Set(
  NATIVE_CHAT_AGENT_ADAPTERS.list().map(nativeChatAgentId)
)

/** Returns whether an agent has a built-in Chat UI adapter. */
export function isNativeChatSupportedAgent(agent: string | null | undefined): boolean {
  return NATIVE_CHAT_AGENT_ADAPTERS.get(agent) !== null
}

/** True when the agent renders a digit-commit question selector that ignores
 *  typed label text. The adapter owns this input policy independently from its
 *  transcript family. */
export function shouldStepNativeChatAskAnswer(agent: string | null | undefined): boolean {
  return NATIVE_CHAT_AGENT_ADAPTERS.get(agent)?.askAnswerMode === 'step-lines'
}

/** Resolves the transcript format family used by an agent's built-in adapter. */
export function resolveNativeChatTranscriptAgent(
  agent: string | null | undefined
): NativeChatTranscriptAgent | null {
  return NATIVE_CHAT_AGENT_ADAPTERS.get(agent)?.transcriptAgent ?? null
}
