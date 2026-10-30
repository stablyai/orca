import {
  structuredLaunchCompatibleOptions,
  structuredLaunchRequestedOptions
} from '../../../shared/native-chat/input/native-chat-session-option-defaults'
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
  structuredAgentSessionMessageSelection,
  structuredAgentSessionOptionView,
  structuredAgentSessionSendSelection
} from '../../../shared/structured-agent-session-option-view'
import { firstFrameOptionState } from '@/components/native-chat/use-structured-agent-session-option-state'
import {
  applyStructuredLaunchHeldOptions,
  applyStructuredLaunchExplicitOptions,
  holdStructuredLaunchCreatePicks,
  structuredLaunchOptionOverlay,
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
  // Options without a model overlay the host's remembered model selection.
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
  const { options: requested, selection } = structuredLaunchCreateOptions(state)
  const options =
    requested && state.selection.explicit && !optionsMode
      ? structuredLaunchCompatibleOptions(intent.agent, requested)
      : requested
  const params = {
    ...intent.params,
    ...(firstMessage
      ? { firstMessage: { ...firstMessage, ...(selection !== undefined ? { selection } : {}) } }
      : {}),
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

/** The first turn uses held picks over the action's choices over the chat's shown selection. */
function structuredLaunchCreateOptions(state: StructuredLaunchState): {
  options?: Readonly<Record<string, string>>
  selection?: Readonly<Record<string, string>>
} {
  const { intent } = state
  const overlay = structuredLaunchOptionOverlay(state)
  const requested = structuredLaunchRequestedOptions({ ...state.selection, held: overlay })
  const firstFrame = firstFrameOptionState(intent.agent, intent.target, {
    newLaunch: !intent.params.resumeFrom,
    worktree: intent.params.worktree,
    seedsModel: intent.seedOptions?.model !== undefined
  })
  // Create has always carried options, so any host takes what the chat shows.
  const view = structuredAgentSessionOptionView(
    firstFrame,
    intent.seedOptions,
    { ...requested, ...overlay },
    state.selection.explicit
  )
  const drawn = structuredAgentSessionDrawnValues(view)
  // Each held value as the picker draws it; the held picks themselves stay as the user made them.
  const held = Object.fromEntries(
    Object.entries(overlay).map(([id, encoded]) => {
      const value = id === 'model' ? undefined : drawn[id]?.value
      const shown = value === undefined ? null : encodeStructuredAgentSessionOptionValue(id, value)
      return [id, shown ?? encoded]
    })
  )
  holdStructuredLaunchCreatePicks(state)
  const options =
    requested?.model !== undefined
      ? requested.model === overlay.model
        ? { ...requested, ...held }
        : requested
      : {
          ...structuredAgentSessionSendSelection(view),
          ...requested,
          ...held
        }
  return {
    ...(Object.keys(options).length ? { options } : {}),
    ...(intent.sendSelectionSupport
      ? { selection: structuredAgentSessionMessageSelection(view) }
      : {})
  }
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
  void applyStructuredLaunchHeldOptions(state, receipt, false).catch((error: unknown) => {
    console.warn('[native-chat] applying a launch option failed', error)
  })
  return receipt
}
