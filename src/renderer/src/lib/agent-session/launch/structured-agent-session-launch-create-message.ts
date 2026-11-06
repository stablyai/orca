import { StructuredAgentSessionCreateUnknownOutcomeError } from './structured-agent-session-launch-errors'
import {
  structuredLaunchCompatibleOptions,
  structuredLaunchRequestedOptions
} from '../../../../../shared/native-chat/input/native-chat-session-option-defaults'
import { structuredAgentSessionCreateFingerprint } from '../../../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import {
  type StructuredLaunchState,
  notifyStructuredLaunchListeners
} from './structured-agent-session-launch-registry'
import {
  prepareStructuredLaunchPromptForCreate,
  hasStagedStructuredLaunchPrompt,
  issueStructuredLaunchPromptForCreate,
  prepareLegacyStructuredLaunchPrompts
} from './structured-agent-session-launch-prompt'
import type { StructuredAgentLaunchReceipt } from './structured-agent-session-launch-recovery'
import {
  structuredAgentSessionMessageSelection,
  structuredAgentSessionOptionView,
  structuredAgentSessionSendSelection
} from '../../../../../shared/agent-session/options/structured-agent-session-option-view'
import { firstFrameOptionState } from '@/components/native-chat/structured-agent-session-option-first-frame'
import {
  applyStructuredLaunchHeldOptions,
  applyStructuredLaunchExplicitOptions,
  holdStructuredLaunchCreatePicks,
  structuredLaunchOptionOverlay,
  settleStructuredLaunchCreateOptions
} from './structured-agent-session-launch-options'
import { structuredAgentSessionDrawnValues } from '../../../../../shared/agent-session/options/structured-agent-session-option-snapshot'
import { encodeStructuredAgentSessionOptionValue } from '../../../../../shared/agent-session/options/structured-agent-session-option-codec'

/** Freeze what create carries once; later evidence must join this exact input.
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
  if (intent.createMessageSupport !== true) {
    prepareLegacyStructuredLaunchPrompts(intent.sessionId)
    intent.createPrepared = true
    notifyStructuredLaunchListeners()
    return
  }
  const hadPrompt = hasStagedStructuredLaunchPrompt(intent.sessionId)
  const { firstMessage, deferred } = prepareStructuredLaunchPromptForCreate(
    intent.sessionId,
    intent.target,
    intent.sendSkillsSupport === true
  )
  if (!deferred && (hadPrompt || firstMessage)) {
    const beforeCreate = intent.beforeCreate
    intent.beforeCreate = () =>
      beforeCreate?.() !== false && issueStructuredLaunchPromptForCreate(intent.sessionId)
  }
  const { options, optionsMode, selection } = captureStructuredLaunchFirstTurn(state, {
    hostTakesExplicitOptions,
    selection: intent.sendSelectionSupport === true
  })
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

type FirstTurnInput = {
  options?: Readonly<Record<string, string>>
  optionsMode?: 'replace-model-selection'
  selection?: Readonly<Record<string, string>>
}

/** The first turn's options and its message's selection, read from the chat's current picks in
 *  one synchronous step; `freeze` makes the picks they include this turn's, so a later equal pick
 *  is a separate, next-turn choice. `selection`: the host takes a per-message selection.
 *  `hostTakesExplicitOptions`: the host advertises the create options-mode capability. */
export function captureStructuredLaunchFirstTurn(
  state: StructuredLaunchState,
  args: { hostTakesExplicitOptions: boolean; selection: boolean; freeze?: false }
): FirstTurnInput {
  // Options without a model overlay the host's remembered model selection.
  const optionsMode =
    args.hostTakesExplicitOptions && state.selection.explicit?.model !== undefined
      ? ('replace-model-selection' as const)
      : undefined
  const { options: requested, selection } = structuredLaunchCreateOptions(
    state,
    args.selection,
    args.freeze !== false
  )
  const options =
    requested && state.selection.explicit && !optionsMode
      ? structuredLaunchCompatibleOptions(state.intent.agent, requested)
      : requested
  return {
    ...(options ? { options } : {}),
    ...(optionsMode ? { optionsMode } : {}),
    ...(selection ? { selection } : {})
  }
}

/** The first turn uses held picks over the action's choices over the chat's shown selection. */
function structuredLaunchCreateOptions(
  state: StructuredLaunchState,
  withSelection: boolean,
  freeze: boolean
): {
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
  if (intent.params.resumeFrom) {
    if (freeze) {
      holdStructuredLaunchCreatePicks(state)
    }
    const options = { ...requested, ...overlay }
    const view = structuredAgentSessionOptionView(
      firstFrame,
      undefined,
      options,
      state.selection.explicit
    )
    return {
      ...(Object.keys(options).length ? { options } : {}),
      ...(withSelection ? { selection: structuredAgentSessionMessageSelection(view) } : {})
    }
  }
  // Create has always carried options, so any host takes what the chat shows.
  const view = structuredAgentSessionOptionView(
    firstFrame,
    intent.seedOptions,
    { ...requested, ...overlay },
    state.selection.explicit
  )
  const drawn = structuredAgentSessionDrawnValues(view)
  // Model and effort remain raw action input; tier retains its existing display projection.
  const held = Object.fromEntries(
    Object.entries(overlay).map(([id, encoded]) => {
      const value = id === 'model' || id === 'effort' ? undefined : drawn[id]?.value
      const shown = value === undefined ? null : encodeStructuredAgentSessionOptionValue(id, value)
      return [id, shown ?? encoded]
    })
  )
  if (freeze) {
    holdStructuredLaunchCreatePicks(state)
  }
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
    ...(withSelection ? { selection: structuredAgentSessionMessageSelection(view) } : {})
  }
}

/** Later picks use the normal option path without holding publication behind startup. A host
 *  launch released with its first turn already ran with the picks it carried; only later ones are
 *  sent, as choices for the next turn. */
export function publishStructuredLaunchCreateOptions(
  state: StructuredLaunchState,
  receipt: StructuredAgentLaunchReceipt
): StructuredAgentLaunchReceipt | Promise<StructuredAgentLaunchReceipt> {
  const released = state.intent.hostLaunch?.firstTurn
  if (state.intent.createMessageSupport !== true && released?.phase !== 'submitted') {
    return applyStructuredLaunchExplicitOptions(state, receipt)
  }
  settleStructuredLaunchCreateOptions(state, {
    kind: 'accepted',
    options:
      (released?.phase === 'submitted' ? released.options : state.intent.params.options) ?? {}
  })
  void applyStructuredLaunchHeldOptions(state, receipt, false).catch((error: unknown) => {
    console.warn('[native-chat] applying a launch option failed', error)
  })
  return receipt
}

/** Every sender waits on the launch promise, so picks held during launch reach the host first. */
export function publishWithHeldOptions(
  state: StructuredLaunchState,
  created: Promise<StructuredAgentLaunchReceipt>
): Promise<StructuredAgentLaunchReceipt> {
  state.intent.prepareCreate = (hostTakesExplicitOptions) =>
    prepareStructuredLaunchCreateMessage(state, hostTakesExplicitOptions)
  const publishing: Promise<StructuredAgentLaunchReceipt> = created
    .then((receipt) =>
      state.promise === publishing
        ? publishStructuredLaunchCreateOptions(state, receipt)
        : state.intent.params.firstMessage
          ? receipt
          : state.promise
    )
    .catch((error: unknown) => {
      if (state.promise !== publishing && state.intent.params.firstMessage) {
        throw new StructuredAgentSessionCreateUnknownOutcomeError(
          'Opening message outcome belongs to the current attempt.',
          'agent_session_operation_unknown'
        )
      }
      throw error
    })
  return publishing
}
