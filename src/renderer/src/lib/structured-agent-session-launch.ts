import { useAppStore } from '@/store'
import { reserveStructuredLaunchSlot } from './structured-agent-session-launch-surface'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  abandonStructuredAgentSessionLaunchIntent,
  createStructuredAgentSessionLaunchIntent,
  retryStructuredAgentSessionLaunchIntent
} from '@/lib/launch-structured-agent-session'
import {
  discardStructuredAgentSessionChatSends,
  stageStructuredLaunchPrompt
} from '@/lib/structured-agent-session-launch-prompt'
import {
  launchAndReconcile,
  reconcileUnknownLaunch,
  type StructuredAgentLaunchReceipt
} from '@/lib/agent-session/launch/structured-agent-session-launch-recovery'
import type { StructuredPromptDeliveryResult } from '@/lib/structured-agent-session-launch-prompt'
import {
  addStructuredLaunchCaller,
  launchPromptText,
  joinLaunchDelivery,
  promptOwner,
  createStructuredLaunchCallerGroup,
  releaseStructuredLaunchCallerAfterUnknownOutcome,
  type StructuredAgentLaunchOptions,
  type StructuredLaunchCaller
} from '@/lib/structured-agent-session-launch-callers'
import * as launchDraft from './structured-agent-session-launch-draft'
import {
  getStructuredAgentSessionLaunchLifecycle,
  getStructuredLaunchStateBySessionId,
  markStructuredAgentSessionLaunchCancelled,
  notifyStructuredLaunchListeners,
  setStructuredLaunchState,
  structuredLaunchIdentity,
  type StructuredLaunchState
} from './agent-session/launch/structured-agent-session-launch-registry'
import { restorePersistedStructuredLaunchState } from './agent-session/launch/structured-agent-session-launch-reload'
import { getJoinableStructuredLaunchState } from './agent-session/launch/structured-agent-session-launch-holders'
import {
  prepareStructuredLaunchCreateMessage,
  publishStructuredLaunchCreateOptions
} from './structured-agent-session-launch-create-message'
import {
  maybeCleanupLaunchState,
  trackLaunchSettlement
} from './agent-session/launch/structured-agent-session-launch-outcome-tracking'
import {
  boundedStructuredLaunchResult,
  trackStructuredLaunchPromptOutcome,
  trackStructuredLaunchConfirmationDeadline
} from './agent-session/launch/structured-agent-session-launch-prompt-outcome'
import { repeatedStructuredLaunchAttempt } from './structured-agent-session-launch-request'
import {
  initialStructuredLaunchSelection,
  structuredLaunchSelectionController
} from './structured-agent-session-launch-options'
import { releaseStructuredLaunchSource } from './structured-agent-session-launch-source-handoff'

export type { StructuredAgentLaunchOptions, StructuredAgentLaunchReceipt }
export {
  getStructuredAgentSessionLaunchLifecycle,
  getStructuredAgentSessionLaunchResumes,
  hasStructuredAgentSessionLaunchCancellationTombstone,
  markStructuredAgentSessionLaunchCancelled,
  retireStructuredAgentSessionLaunchCancellationTombstone,
  shouldRetainStructuredAgentSessionLaunchTab,
  subscribeStructuredAgentLaunchStatus,
  useStructuredAgentSessionLaunchFailure,
  useStructuredAgentSessionLaunchLifecycle,
  type StructuredAgentLaunchStatus,
  type StructuredAgentSessionLaunchLifecycle
} from './agent-session/launch/structured-agent-session-launch-registry'
export * from './structured-agent-session-launch-status'
export { useStructuredAgentSessionLaunchSelection } from './structured-agent-session-launch-options'

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

/** Every sender waits on the launch promise, so picks held during launch reach the host first. */
function publishWithHeldOptions(
  state: StructuredLaunchState,
  created: Promise<StructuredAgentLaunchReceipt>
): Promise<StructuredAgentLaunchReceipt> {
  state.intent.prepareCreate = (hostTakesExplicitOptions) =>
    prepareStructuredLaunchCreateMessage(state, hostTakesExplicitOptions)
  const publishing: Promise<StructuredAgentLaunchReceipt> = created.then((receipt) =>
    state.promise === publishing
      ? publishStructuredLaunchCreateOptions(state, receipt)
      : state.promise
  )
  return publishing
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
  notifyStructuredLaunchListeners()
}

function resetStructuredLaunchCallers(state: StructuredLaunchState): void {
  state.callers = createStructuredLaunchCallerGroup({ kind: 'retry' })
  state.callers.onSettled = () => maybeCleanupLaunchState(state)
}

function restartStructuredLaunchState(state: StructuredLaunchState): void {
  const wasVisibilityUnknown = state.visibilityUnknown
  if (!wasVisibilityUnknown) {
    const surfaceAddress = state.intent.surfaceAddress
    state.intent = retryStructuredAgentSessionLaunchIntent(state.intent)
    state.intent.surfaceAddress = surfaceAddress
  }
  resetStructuredLaunchCallers(state)
  delete state.failure
  state.callers.outcome = 'pending'
  // A new create seeds from the settings of now (a paired server's arrive with its probe); picks
  // held through the failure still apply.
  state.selection = initialStructuredLaunchSelection(state.intent)
  state.onHostSeed = (seedOptions) => adoptPairedHostSeed(state, seedOptions)
  state.promise = publishWithHeldOptions(
    state,
    wasVisibilityUnknown ? reconcileUnknownLaunch(state) : launchAndReconcile(state)
  )
  trackLaunchSettlement(state, state.promise)
  trackStructuredLaunchConfirmationDeadline(state, state.promise)
  notifyStructuredLaunchListeners()
}

function joinStructuredLaunchState(
  existing: StructuredLaunchState,
  options: StructuredAgentLaunchOptions
): StructuredLaunchStateResult | undefined {
  // A re-delivery of the same action shares the text it staged, so it is sent once.
  const repeat = repeatedStructuredLaunchAttempt(existing.callers.attempt, options.requestId)
  const retrying = existing.visibilityUnknown && !existing.intent.params.firstMessage
  const retained = existing.visibilityUnknown && !!existing.intent.params.firstMessage
  const joined = joinLaunchDelivery(options, existing.promptDelivery)
  // Unconfirmed launches retain text; rechecks must not stage/send a second copy.
  const text = retrying || retained || repeat ? '' : launchPromptText(joined)
  const stagedPrompt = text
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
  const { prompt: _retryPrompt, ...joinedWithoutPrompt } = joined
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
    options.activate
  )
  intent.explicitLaunchOptions = options.launchOptions ? { ...options.launchOptions } : undefined
  intent.beforeCreate = options.beforeCreate
  intent.surfaceAddress = options.surfaceAddress
  const text = launchPromptText(options)
  const stagedPrompt = text
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
    onVisibilityChanged: notifyStructuredLaunchListeners,
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
  notifyStructuredLaunchListeners()
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
  notifyStructuredLaunchListeners()
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
    (state.visibilityUnknown && !!state.intent.params.firstMessage) ||
    (!state.visibilityUnknown && state.callers.outcome !== 'failed')
  ) {
    return false
  }
  restartStructuredLaunchState(state)
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
