import { useAppStore } from '@/store/index'
import { reserveStructuredLaunchSlot } from './structured-agent-session-launch-surface'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import {
  abandonStructuredAgentSessionLaunchIntent,
  createStructuredAgentSessionLaunchIntent,
  retryStructuredAgentSessionLaunchIntent
} from '@/lib/launch-structured-agent-session'
import {
  discardStructuredAgentSessionChatSends,
  stageStructuredLaunchPrompt,
  type StructuredPromptDeliveryResult
} from '@/lib/agent-session/launch/structured-agent-session-launch-prompt'
import {
  launchAndReconcile,
  reconcileUnknownLaunch,
  type StructuredAgentLaunchReceipt
} from '@/lib/agent-session/launch/structured-agent-session-launch-recovery'
import {
  addStructuredLaunchCaller,
  launchPromptText,
  joinLaunchDelivery,
  promptOwner,
  createStructuredLaunchCallerGroup,
  releaseStructuredLaunchCallerAfterUnknownOutcome,
  type StructuredAgentLaunchOptions,
  type StructuredLaunchCaller
} from '@/lib/agent-session/launch/structured-agent-session-launch-callers'
import {
  getStructuredAgentSessionLaunchLifecycle,
  getStructuredLaunchStateBySessionId,
  notifyStructuredLaunchStateChanged,
  setStructuredLaunchState,
  structuredLaunchIdentity,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'
import { markStructuredAgentSessionLaunchCancelled } from './structured-agent-session-launch-cancel'
import { restorePersistedStructuredLaunchState } from './structured-agent-session-launch-reload'
import { getJoinableStructuredLaunchState } from './structured-agent-session-launch-holders'
import { publishWithHeldOptions } from './structured-agent-session-launch-create-message'
import {
  maybeCleanupLaunchState,
  resetStructuredLaunchCallers,
  trackLaunchSettlement
} from './structured-agent-session-launch-outcome-tracking'
import {
  boundedStructuredLaunchResult,
  trackStructuredLaunchPromptOutcome,
  trackStructuredLaunchConfirmationDeadline
} from './structured-agent-session-launch-prompt-outcome'
import { repeatedStructuredLaunchAttempt } from './structured-agent-session-launch-request'
import {
  initialStructuredLaunchSelection,
  structuredLaunchSelectionController
} from './structured-agent-session-launch-options'
import { releaseStructuredLaunchSource } from './structured-agent-session-launch-source-handoff'
import { joinHeldHostLaunch } from './structured-agent-session-host-launch-join'
import { adoptRereadHostLaunchTerminal } from './structured-agent-session-host-launch-terminal'
import * as launchDraft from './structured-agent-session-launch-draft'
import { ordinaryLaunchOpening } from './structured-agent-session-launch-opening'

type StructuredLaunchStateResult = {
  state: StructuredLaunchState
  caller: StructuredLaunchCaller
  joined: boolean
}

export type StructuredAgentLaunchResult = {
  joined: boolean
  sessionId: string
  executionHostId: ExecutionHostId
  launchResult: Promise<StructuredAgentLaunchReceipt>
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
  isVisibilityUnknown: () => boolean
  releaseCallerAfterUnknownOutcome: () => boolean
}

/** Each attempt's probe names the seed the paired server's create will use; the picker shows it. */
function adoptPairedHostSeed(
  state: StructuredLaunchState,
  seedOptions: StructuredLaunchState['selection']['seed']
): void {
  // The support answer is a fresh seed; continuation baseline belongs to actual host create.
  if (state.intent.params.resumeFrom) {
    seedOptions = undefined
  }
  const { seedPending, ...selection } = state.selection
  if (!seedPending && JSON.stringify(seedOptions) === JSON.stringify(state.intent.seedOptions)) {
    return
  }
  if (seedOptions) {
    state.intent.seedOptions = seedOptions
  } else {
    delete state.intent.seedOptions
  }
  state.selection = { ...selection, seed: seedOptions }
  notifyStructuredLaunchStateChanged(state)
}

function restartStructuredLaunchState(state: StructuredLaunchState, requested = false): void {
  const wasVisibilityUnknown = state.visibilityUnknown
  const retainedOpening = wasVisibilityUnknown && !!ordinaryLaunchOpening(state.intent)
  // A host launch keeps its operation whatever became of it: restarting it only reads it again.
  if (!state.intent.hostLaunch && (!wasVisibilityUnknown || (retainedOpening && requested))) {
    const surfaceAddress = state.intent.surfaceAddress
    state.intent = retryStructuredAgentSessionLaunchIntent(state.intent, retainedOpening)
    state.intent.surfaceAddress = surfaceAddress
  }
  resetStructuredLaunchCallers(state, retainedOpening)
  delete state.failure
  delete state.operationEnded
  state.callers.outcome = 'pending'
  // A new create seeds from now's settings (a paired server's come with its probe); a host
  // launch read again and an opening retained keep the picks made for them.
  if (!retainedOpening && !state.intent.hostLaunch) {
    state.selection = initialStructuredLaunchSelection(state.intent)
  }
  state.onHostSeed = retainedOpening
    ? undefined
    : (seedOptions) => adoptPairedHostSeed(state, seedOptions)
  state.promise = publishWithHeldOptions(
    state,
    wasVisibilityUnknown ? reconcileUnknownLaunch(state, requested) : launchAndReconcile(state)
  )
  trackLaunchSettlement(state, state.promise)
  trackStructuredLaunchConfirmationDeadline(state, state.promise)
  notifyStructuredLaunchStateChanged(state)
}

function joinStructuredLaunchState(
  existing: StructuredLaunchState,
  options: StructuredAgentLaunchOptions
): StructuredLaunchStateResult | undefined {
  // A re-delivery of the same action shares the text it staged, so it is sent once.
  const repeat = repeatedStructuredLaunchAttempt(existing.callers.attempt, options.requestId)
  const retained = existing.visibilityUnknown && !!ordinaryLaunchOpening(existing.intent)
  const retrying = existing.visibilityUnknown && !retained
  const joined = joinLaunchDelivery(options, existing.promptDelivery)
  // Unconfirmed launches retain text; rechecks must not stage/send a second copy.
  const text = retrying || retained || repeat ? '' : launchPromptText(joined)
  const stagedPrompt =
    text ||
    (!retrying &&
      !retained &&
      !repeat &&
      joined.promptDelivery !== 'draft' &&
      joined.promptAttachments?.length)
      ? stageStructuredLaunchPrompt(existing.intent.sessionId, text, promptOwner(options))
      : (repeat?.stagedPrompt ?? null)
  if (retrying) {
    restartStructuredLaunchState(existing)
  } else if (!retained && !options.resumeFrom?.cliSource) {
    releaseStructuredLaunchSource(existing)
  }
  if (!retrying && !retained && !repeat) {
    launchDraft.seedStructuredAgentLaunchDraft(existing, joined)
  }
  // A re-delivery waits on the text its action staged, if any, and never stages its own.
  const {
    prompt: _retryPrompt,
    promptAttachments: _retryAttachments,
    promptSkills: _retrySkills,
    preparePrompt: _retryPrepare,
    ...joinedWithoutPrompt
  } = joined
  const callerOptions =
    retrying || retained || (repeat && !repeat.stagedPrompt) ? joinedWithoutPrompt : joined
  const caller = addStructuredLaunchCaller({
    group: existing.callers,
    launchResult: existing.promise,
    target: existing.intent.target,
    options: callerOptions,
    stagedPrompt
  })
  trackStructuredLaunchPromptOutcome(existing, caller)
  return { state: existing, caller, joined: true }
}

function structuredAgentLaunchState(
  worktreeId: string,
  agent: TuiAgent,
  options: StructuredAgentLaunchOptions
): StructuredLaunchStateResult {
  const held = joinHeldHostLaunch(worktreeId, agent, options, restartStructuredLaunchState)
  if (held) {
    return held
  }
  const identity = structuredLaunchIdentity(worktreeId, agent, options)
  const existing = getJoinableStructuredLaunchState(identity, options.requestId)
  const joined = existing && joinStructuredLaunchState(existing, options)
  if (joined) {
    return joined
  }

  const intent = createStructuredAgentSessionLaunchIntent(
    worktreeId,
    agent,
    options.executionHostId,
    options.resumeFrom,
    options.hostSeedOptions,
    options.activate,
    options.hostLaunch
  )
  intent.explicitLaunchOptions = options.launchOptions ? { ...options.launchOptions } : undefined
  intent.beforeCreate = options.beforeCreate
  intent.createAfter = options.createAfter
  intent.surfaceAddress = options.surfaceAddress
  const text = launchPromptText(options)
  const stagedPrompt =
    text || (options.promptDelivery !== 'draft' && options.promptAttachments?.length)
      ? stageStructuredLaunchPrompt(intent.sessionId, text, promptOwner(options))
      : null
  const callers = createStructuredLaunchCallerGroup({
    kind: 'first',
    requestId: options.requestId,
    stagedPrompt
  })
  const state: StructuredLaunchState = {
    identity,
    intent,
    promptDelivery: options.promptDelivery,
    promise: Promise.resolve({ sessionId: '', fence: 0 }),
    visibilityUnknown: false,
    cancelled: false,
    onVisibilityChanged: () => notifyStructuredLaunchStateChanged(state),
    callers,
    selection: initialStructuredLaunchSelection(intent)
  }
  launchDraft.seedStructuredAgentLaunchDraft(state, options)
  state.onHostSeed = (seedOptions) => adoptPairedHostSeed(state, seedOptions)
  callers.onSettled = () => maybeCleanupLaunchState(state)
  structuredLaunchSelectionController(state)
  setStructuredLaunchState(state)
  reserveStructuredLaunchSlot(state.intent)
  state.promise = publishWithHeldOptions(state, launchAndReconcile(state))
  const caller = addStructuredLaunchCaller({
    group: state.callers,
    launchResult: state.promise,
    target: state.intent.target,
    options,
    stagedPrompt
  })
  trackStructuredLaunchPromptOutcome(state, caller)
  setStructuredLaunchState(state)
  notifyStructuredLaunchStateChanged(state)
  trackLaunchSettlement(state, state.promise)
  return { state, caller, joined: false }
}

export function cancelStructuredAgentLaunch(worktreeId: string, sessionId: string): boolean {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (!state) {
    return false
  }
  markStructuredAgentSessionLaunchCancelled(
    worktreeId,
    sessionId,
    state.intent.executionHostId,
    useAppStore.getState()
  )
  discardStructuredAgentSessionChatSends(state.intent.sessionId)
  abandonStructuredAgentSessionLaunchIntent(state.intent)
  notifyStructuredLaunchStateChanged(state)
  return true
}

export function startStructuredAgentLaunch(
  worktreeId: string,
  agent: TuiAgent,
  options: StructuredAgentLaunchOptions
): StructuredAgentLaunchResult {
  const { state, caller, joined } = structuredAgentLaunchState(worktreeId, agent, options)
  return {
    joined,
    sessionId: state.intent.sessionId,
    executionHostId: state.intent.executionHostId,
    launchResult: boundedStructuredLaunchResult(state, caller),
    ...(caller.promptDeliveryResult ? { promptDeliveryResult: caller.promptDeliveryResult } : {}),
    isVisibilityUnknown: () => state.visibilityUnknown,
    releaseCallerAfterUnknownOutcome: () =>
      releaseStructuredLaunchCallerAfterUnknownOutcome(state.callers, caller)
  }
}

export function retryStructuredAgentSessionLaunch(worktreeId: string, sessionId: string): boolean {
  const state =
    getStructuredLaunchStateBySessionId(sessionId) ??
    restorePersistedStructuredLaunchState(worktreeId, sessionId)
  if (
    state?.intent.worktreeId !== worktreeId ||
    state.cancelled ||
    state.callers.outcome === 'pending' ||
    (!state.visibilityUnknown && state.callers.outcome !== 'failed')
  ) {
    return false
  }
  // Only reads the host's record of its launch, unknown or failed; whatever that started shows in
  // the chat's place.
  const rereadsHostLaunch = state.intent.hostLaunch !== undefined
  restartStructuredLaunchState(state, true)
  if (rereadsHostLaunch) {
    adoptRereadHostLaunchTerminal(state)
  }
  return true
}

/** Share failed-unpublished chat relaunch between its composer and external message callers. */
export function relaunchFailedStructuredAgentSessionForMessage(
  worktreeId: string,
  sessionId: string
): void {
  if (getStructuredAgentSessionLaunchLifecycle(worktreeId, sessionId) === 'failed') {
    retryStructuredAgentSessionLaunch(worktreeId, sessionId)
  }
}
