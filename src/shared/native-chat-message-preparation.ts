// Share transcript preparation across desktop/mobile so neither drops turns the other renders.

import type { AgentType } from './agent-status-types'
import { getVerifiedNativeChatCommands } from './native-chat-agent-profiles'
import { surfaceSkillInvocationUserTurns } from './native-chat/native-chat-command-envelope'
import { surfaceNativeChatCommandOutputs } from './native-chat/tools/native-chat-command-output'
import { normalizeImageTranscriptMessages } from './native-chat-image-transcript-markers'
import type { NativeChatMessage } from './native-chat-types'

/** Surface skill invocation text and reporting-command output before noise filtering hides their harness envelopes. */
export function surfaceNativeChatHarnessTurns(
  messages: readonly NativeChatMessage[],
  agent: AgentType
): NativeChatMessage[] {
  const commandNames = new Set(getVerifiedNativeChatCommands(agent).map((command) => command.name))
  return surfaceNativeChatCommandOutputs(
    surfaceSkillInvocationUserTurns(messages, commandNames),
    agent
  )
}

/** The harness turns surfaced, then image marker turns folded into the prompt they belong to. */
export function prepareNativeChatMessages(
  messages: readonly NativeChatMessage[],
  agent: AgentType
): NativeChatMessage[] {
  return normalizeImageTranscriptMessages(surfaceNativeChatHarnessTurns(messages, agent))
}
