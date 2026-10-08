// A message sent to a chat whose start failed: it restarts the chat and goes as the restart's first
// message, holding the chat's one send slot from now until the chat exists, as a launch prompt does.

import { addStructuredLaunchCaller } from './structured-agent-session-launch-callers'
import {
  stageStructuredLaunchPrompt,
  type StructuredPromptDeliveryResult
} from './structured-agent-session-launch-prompt'
import {
  getStructuredAgentSessionLaunchLifecycle,
  getStructuredLaunchStateBySessionId
} from './structured-agent-session-launch-registry'
import { retryStructuredAgentSessionLaunch } from './structured-agent-session-launch'
import { newAgentLaunchRequestId } from './agent-launch-request-id'

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
  return caller.promptDeliveryResult ?? null
}
