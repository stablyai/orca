import {
  structuredLaunchCompatibleOptions,
  structuredLaunchRequestedOptions
} from '../../../shared/native-chat-session-option-defaults'
import { structuredAgentSessionCreateFingerprint } from '../../../shared/structured-agent-session-mutation'
import type { StructuredAgentSessionCreateParams } from '../../../shared/structured-agent-session-create'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../shared/agent-chat-permission-mode'
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
  applyStructuredLaunchExplicitOptions,
  holdStructuredLaunchCreatePicks,
  settleStructuredLaunchCreateOptions
} from './structured-agent-session-launch-options'
import { structuredAgentSessionDrawnValues } from '../../../shared/structured-agent-session-option-snapshot'
import { encodeStructuredAgentSessionOptionValue } from '../../../shared/structured-agent-session-option-codec'

/** Freeze what create carries once; an ambiguous reply always replays the same payload.
 *  `hostTakesExplicitOptions`: the host advertises the create options-mode capability. */
export function prepareStructuredLaunchCreateMessage(
  state: StructuredLaunchState,
  hostTakesExplicitOptions: boolean
): void {
  const { intent } = state
  if (intent.createPrepared) {
    return
  }
  if (!hostTakesExplicitOptions) {
    omitStructuredLaunchPermissionMode(state)
  }
  // A permission mode alone overlays the host's remembered model selection.
  const optionsMode: StructuredAgentSessionCreateParams['optionsMode'] =
    hostTakesExplicitOptions && state.selection.explicit?.model !== undefined
      ? 'replace-model-selection'
      : undefined
  if (intent.createMessageSupport !== true) {
    prepareLegacyStructuredLaunchPrompts(intent.sessionId)
    intent.createPrepared = true
    notifyStructuredLaunchListeners()
    return
  }
  const firstMessage = prepareStructuredLaunchPromptForCreate(intent.sessionId, intent.target)
  const requested = structuredLaunchCreateOptions(state)
  const options =
    requested && state.selection.explicit && !optionsMode
      ? structuredLaunchCompatibleOptions(intent.agent, requested)
      : requested
  const params = {
    ...intent.params,
    ...(firstMessage ? { firstMessage } : {}),
    ...(options ? { options } : {}),
    ...(optionsMode ? { optionsMode } : {})
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

/** Hosts before options-mode may refuse an action's mode (older permission tables): the chat takes
 *  the host's new-chat default, as a phone launch does, and no later setOption re-applies it. */
function omitStructuredLaunchPermissionMode(state: StructuredLaunchState): void {
  const explicit = state.intent.explicitLaunchOptions
  if (explicit?.[AGENT_CHAT_PERMISSION_MODE_OPTION_ID] === undefined) {
    return
  }
  const { [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: _omitted, ...rest } = explicit
  const kept = Object.keys(rest).length ? rest : undefined
  state.intent.explicitLaunchOptions = kept
  state.selection = { ...state.selection, explicit: kept }
}

/** Picks held so far, the launch's own permission mode, and the chat's own model and effort: a
 *  first message starts its turn on them, as a later send does. */
function structuredLaunchCreateOptions(
  state: StructuredLaunchState
): Readonly<Record<string, string>> | undefined {
  const { intent, selection } = state
  const requested = structuredLaunchRequestedOptions(selection)
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
  if (requested?.model !== undefined) {
    // The view draws under a re-picked model only; an action's own model keeps picks as made.
    return requested.model === selection.held.model ? { ...requested, ...held } : requested
  }
  const options = {
    ...(requested ? { ...requested, ...held } : held),
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
    return applyStructuredLaunchExplicitOptions(state, receipt)
  }
  settleStructuredLaunchCreateOptions(state, state.intent.params.options ?? {})
  void applyStructuredLaunchHeldOptions(state, receipt).catch((error: unknown) => {
    console.warn('[native-chat] applying a launch option failed', error)
  })
  return receipt
}
