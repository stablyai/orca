// What a chat reads from a terminal agent's transcript before folding it into rows. Desktop and
// mobile both prepare through here, so a turn one of them draws is never dropped by the other.

import type { AgentType } from './agent-status-types'
import { getVerifiedNativeChatCommands } from './native-chat-agent-profiles'
import { surfaceSkillInvocationUserTurns } from './native-chat-command-envelope'
import { surfaceNativeChatCommandOutputs } from './native-chat-command-output'
import { normalizeImageTranscriptMessages } from './native-chat-image-transcript-markers'
import type { NativeChatMessage } from './native-chat-types'

/** A skill invocation as the `/name args` the user sent, and a reporting command's reply as its
 *  output; the harness records both as envelopes the noise filter would otherwise hide. */
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
