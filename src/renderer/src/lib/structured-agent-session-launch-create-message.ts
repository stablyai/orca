import { structuredAgentSessionCreateFingerprint } from '../../../shared/structured-agent-session-mutation'
import type { StructuredLaunchState } from './agent-session/launch/structured-agent-session-launch-registry'
import { notifyStructuredLaunchListeners } from './agent-session/launch/structured-agent-session-launch-registry'
import {
  prepareStructuredLaunchPromptForCreate,
  prepareLegacyStructuredLaunchPrompts
} from './structured-agent-session-launch-prompt'
import type { StructuredAgentLaunchReceipt } from './agent-session/launch/structured-agent-session-launch-recovery'
import {
  structuredAgentSessionOptionView,
  structuredAgentSessionSendSelection
} from '../../../shared/structured-agent-session-option-view'
import { firstFrameOptionState } from '@/components/native-chat/use-structured-agent-session-option-state'
import {
  applyStructuredLaunchHeldOptions,
  holdStructuredLaunchCreatePicks,
  settleStructuredLaunchCreateOptions
} from './structured-agent-session-launch-options'
import { structuredAgentSessionDrawnValues } from '../../../shared/structured-agent-session-option-snapshot'
import { encodeStructuredAgentSessionOptionValue } from '../../../shared/structured-agent-session-option-codec'

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
  const options = structuredLaunchCreateOptions(state)
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

// Apply held picks and chat model/effort to the opening turn, matching ordinary sends.
function structuredLaunchCreateOptions(
  state: StructuredLaunchState
): Readonly<Record<string, string>> | undefined {
  const { intent, selection } = state
  const firstFrame = firstFrameOptionState(intent.agent, intent.target, {
    newLaunch: !intent.params.resumeFrom,
    worktree: intent.params.worktree,
    seedsModel: intent.seedOptions?.model !== undefined
  })
  // Create has always carried options, so any host takes what the chat shows.
  const view = structuredAgentSessionOptionView(firstFrame, intent.seedOptions, selection.held)
  const drawn = structuredAgentSessionDrawnValues(view)
  // Each held value as the picker draws it; the held picks themselves stay as the user made them.
  const held = Object.fromEntries(
    Object.entries(selection.held).map(([id, encoded]) => {
      const value = id === 'model' ? undefined : drawn[id]?.value
      const shown = value === undefined ? null : encodeStructuredAgentSessionOptionValue(id, value)
      return [id, shown ?? encoded]
    })
  )
  holdStructuredLaunchCreatePicks(state, selection.held)
  const options = {
    ...held,
    ...structuredAgentSessionSendSelection(view)
  }
  return Object.keys(options).length ? options : undefined
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
