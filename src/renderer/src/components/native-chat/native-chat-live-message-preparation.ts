import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat-agent-profiles'
import { surfaceSkillInvocationUserTurns } from '../../../../shared/native-chat-command-envelope'
import { normalizeImageTranscriptMessages } from '../../../../shared/native-chat-image-transcript-markers'
import type { AgentType, NativeChatMessage } from '../../../../shared/native-chat-types'
import { mergeOmpRpcHydratedHistory } from './native-chat-rpc-history-merge'
import { assembleNativeChatSession } from './native-chat-session-assembler'

/**
 * `rpcHistoryMessages` is a hydrated OMP RPC history snapshot, folded in LAST
 * and deliberately not passed through the cross-source pass below: that pass
 * dedupes by turn content, which would undo the positional reconciliation
 * `mergeOmpRpcHydratedHistory` performed and collapse a repeated turn whose
 * copies only one window reaches. Each side is prepared on its own — a
 * single-source list, so the pass is a no-op for it — and then spliced.
 */
export function prepareNativeChatLiveMessages(
  messages: NativeChatMessage[],
  agent: AgentType,
  rpcHistoryMessages: readonly NativeChatMessage[] = []
): NativeChatMessage[] {
  const prepared = prepareOneSource(messages, agent)
  if (rpcHistoryMessages.length === 0) {
    return prepared
  }
  return mergeOmpRpcHydratedHistory(prepared, prepareOneSource([...rpcHistoryMessages], agent))
}

function prepareOneSource(messages: NativeChatMessage[], agent: AgentType): NativeChatMessage[] {
  const commandNames = new Set(getVerifiedNativeChatCommands(agent).map((command) => command.name))
  const surfaced = surfaceSkillInvocationUserTurns(messages, commandNames)
  const normalized = normalizeImageTranscriptMessages(surfaced)
  if (!hasMixedSources(normalized)) {
    return normalized
  }
  // A second pass preserves legacy cross-source winners after sorting or presentation transforms.
  return assembleNativeChatSession({
    sources: { transcript: surfaced },
    sessionId: null,
    agent
  }).messages
}

function hasMixedSources(messages: readonly NativeChatMessage[]): boolean {
  const source = messages[0]?.source
  return messages.some((message) => message.source !== source)
}
