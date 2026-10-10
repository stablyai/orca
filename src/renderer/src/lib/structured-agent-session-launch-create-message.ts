import { structuredAgentSessionCreateFingerprint } from '../../../shared/structured-agent-session-mutation'
import type { StructuredLaunchState } from './structured-agent-session-launch-registry'
import { notifyStructuredLaunchListeners } from './structured-agent-session-launch-registry'
import {
  prepareStructuredLaunchPromptForCreate,
  prepareLegacyStructuredLaunchPrompts
} from './structured-agent-session-launch-prompt'
import type { StructuredAgentLaunchReceipt } from './structured-agent-session-launch-recovery'
import {
  applyStructuredLaunchHeldOptions,
  settleStructuredLaunchCreateOptions
} from './structured-agent-session-launch-options'

/** Freeze what create carries once; an ambiguous reply always replays the same payload. */
export function prepareStructuredLaunchCreateMessage(state: StructuredLaunchState): void {
  const { intent } = state
  if (intent.createPrepared) {
    return
  }
  if (intent.createMessageSupport !== true) {
    prepareLegacyStructuredLaunchPrompts(intent.sessionId)
    intent.createPrepared = true
    notifyStructuredLaunchListeners()
    return
  }
  const firstMessage = prepareStructuredLaunchPromptForCreate(intent.sessionId, intent.target)
  const options = Object.keys(state.selection.held).length ? { ...state.selection.held } : undefined
  const params = {
    ...intent.params,
    ...(firstMessage ? { firstMessage } : {}),
    ...(options ? { options } : {})
  }
  intent.params = {
    ...params,
    envelope: {
      ...params.envelope,
      payloadFingerprint: structuredAgentSessionCreateFingerprint({
        sessionId: intent.sessionId,
        ...params
      })
    }
  }
  intent.createPrepared = true
  notifyStructuredLaunchListeners()
}

/** Later picks use the normal option path without holding publication behind startup. */
export function publishStructuredLaunchCreateOptions(
  state: StructuredLaunchState,
  receipt: StructuredAgentLaunchReceipt
): StructuredAgentLaunchReceipt | Promise<StructuredAgentLaunchReceipt> {
  if (state.intent.createMessageSupport !== true) {
    return applyStructuredLaunchHeldOptions(state, receipt)
  }
  settleStructuredLaunchCreateOptions(state, state.intent.params.options ?? {})
  void applyStructuredLaunchHeldOptions(state, receipt).catch((error: unknown) => {
    console.warn('[native-chat] applying a launch option failed', error)
  })
  return receipt
}
