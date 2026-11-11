// A message sent to a chat whose start failed: it restarts the chat and goes as the restart's first
// message, holding the chat's one send slot from now until the chat exists, as a launch prompt does.

import {
  addStructuredLaunchCaller,
  type StructuredPromptDeliveryResult
} from './structured-agent-session-launch-callers'
import { stageStructuredLaunchPrompt } from './structured-agent-session-staged-prompt'

import { getStructuredAgentSessionLaunchLifecycle } from './structured-agent-session-launch-registry'
import { getStructuredLaunchStateBySessionId } from './structured-agent-session-launch-state-store'
import { retryStructuredAgentSessionLaunch } from './structured-agent-session-launch'
import { newAgentLaunchRequestId } from './routing/agent-launch-request-id'
import { trackStructuredLaunchPromptOutcome } from './structured-agent-session-launch-prompt-outcome'
import { structuredAgentSessionLaunchHasRetainedInput } from './structured-agent-session-launch-input'
import { structuredAgentSessionSendOut } from '@/components/native-chat/session/structured/delivery/structured-agent-session-pending-sends'

/** Null when the chat's start has not failed, or its restart could not begin. */
export function relaunchFailedStructuredAgentSessionWithMessage(
  worktreeId: string,
  sessionId: string,
  text: string,
  options: { callerKeepsText?: true } = {}
): Promise<StructuredPromptDeliveryResult> | null {
  if (
    getStructuredAgentSessionLaunchLifecycle(worktreeId, sessionId) !== 'failed' ||
    !retryStructuredAgentSessionLaunch(worktreeId, sessionId)
  ) {
    return null
  }
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (!state) {
    return null
  }
  const caller = addStructuredLaunchCaller({
    group: state.callers,
    launchResult: state.promise,
    target: state.intent.target,
    options: { requestId: newAgentLaunchRequestId(), prompt: text },
    stagedPrompt: stageStructuredLaunchPrompt(sessionId, text, options)
  })
  trackStructuredLaunchPromptOutcome(state, caller)
  return caller.promptDeliveryResult ?? null
}

/** A message sent while the chat starts: rides create if it is not yet prepared, else goes once the chat exists.
 *  Null when the chat is not starting or its one send slot is taken. */
export function sendMessageToStartingStructuredAgentSession(
  worktreeId: string,
  sessionId: string,
  text: string
): Promise<StructuredPromptDeliveryResult> | null {
  const lifecycle = getStructuredAgentSessionLaunchLifecycle(worktreeId, sessionId)
  const starting =
    lifecycle === 'pending' ||
    (lifecycle === 'visibility-unknown' &&
      !structuredAgentSessionLaunchHasRetainedInput(worktreeId, sessionId))
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (!starting || !state || structuredAgentSessionSendOut(sessionId)) {
    return null
  }
  // Typed before the agent could answer, so it waits behind any opening turn instead of steering it.
  const stagedPrompt = stageStructuredLaunchPrompt(sessionId, text, { delivery: 'queue-if-active' })
  if (!stagedPrompt.slot) {
    return null
  }
  const createWillCarry = !state.intent.createPrepared
  const caller = addStructuredLaunchCaller({
    group: state.callers,
    launchResult: state.promise,
    target: state.intent.target,
    options: { requestId: newAgentLaunchRequestId(), prompt: text },
    stagedPrompt
  })
  // Only an opening message decides the launch; a later one coming back must not fail the chat.
  if (createWillCarry) {
    trackStructuredLaunchPromptOutcome(state, caller)
  }
  return caller.promptDeliveryResult ?? null
}
