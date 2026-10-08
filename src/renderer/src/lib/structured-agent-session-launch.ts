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
} from '@/lib/structured-agent-session-launch-recovery'
import type { StructuredPromptDeliveryResult } from '@/lib/structured-agent-session-launch-prompt'
import {
  addStructuredLaunchCaller,
  createStructuredLaunchCallerGroup,
  releaseStructuredLaunchCallerAfterUnknownOutcome,
  structuredLaunchCallersHavePendingWork,
  type StructuredAgentLaunchOptions,
  type StructuredLaunchCaller
} from '@/lib/structured-agent-session-launch-callers'
import * as launchDraft from './structured-agent-session-launch-draft'
import {
  deleteStructuredLaunchStateIfCurrent,
  getStructuredAgentSessionLaunchLifecycle,
  getStructuredLaunchStateBySessionId,
  markStructuredAgentSessionLaunchCancelled,
  notifyStructuredLaunchListeners,
  setStructuredLaunchState,
  structuredLaunchIdentity,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'
import { restorePersistedStructuredLaunchState } from './structured-agent-session-launch-reload'
import {
  claimableStructuredLaunchAttempt,
  getJoinableStructuredLaunchState
} from './structured-agent-session-launch-holders'
import { applyStructuredLaunchHeldOptions } from './structured-agent-session-launch-options'
import { trackLaunchSettlement } from './structured-agent-session-launch-outcome-tracking'
import {
  repeatedStructuredLaunchAttempt,
  structuredLaunchRequest,
  type StructuredLaunchRequest
} from './structured-agent-session-launch-request'

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
} from './structured-agent-session-launch-registry'
export * from './structured-agent-session-launch-status'
export { useStructuredAgentSessionLaunchSelection } from './structured-agent-session-launch-options'

type StructuredLaunchStateResult = {
  state: StructuredLaunchState
  caller: StructuredLaunchCaller
}

export type StructuredAgentLaunchResult = {
  sessionId: string
  executionHostId: ExecutionHostId
  launchResult: Promise<StructuredAgentLaunchReceipt>
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
  isVisibilityUnknown: () => boolean
  releaseCallerAfterUnknownOutcome: () => boolean
}

/** What the launch sends: a draft goes to the composer seed instead. */
function launchPromptText(options: StructuredAgentLaunchOptions): string {
  return options.promptDelivery === 'draft' ? '' : (options.prompt?.trim() ?? '')
}

function joinLaunchDelivery(
  options: StructuredAgentLaunchOptions,
  established: StructuredAgentLaunchOptions['promptDelivery']
): StructuredAgentLaunchOptions {
  // Why: the first caller's mode wins, but with none established an absent mode reads as submit —
  // that would send a joiner's draft it never consented to send.
  const mode = established ?? options.promptDelivery
  const { promptDelivery: _joinerMode, ...rest } = options
  return mode ? { ...rest, promptDelivery: mode } : rest
}

function cleanupLaunchState(state: StructuredLaunchState): void {
  if (deleteStructuredLaunchStateIfCurrent(state)) {
    notifyStructuredLaunchListeners()
  }
}

function maybeCleanupLaunchState(state: StructuredLaunchState): void {
  if (state.callers.outcome === 'failed' || structuredLaunchCallersHavePendingWork(state.callers)) {
    return
  }
  cleanupLaunchState(state)
}

/** Every sender waits on the launch promise, so picks held during launch reach the host first. */
function publishWithHeldOptions(
  state: StructuredLaunchState,
  created: Promise<StructuredAgentLaunchReceipt>
): Promise<StructuredAgentLaunchReceipt> {
  return created.then((receipt) => applyStructuredLaunchHeldOptions(state, receipt))
}

/** The picker and saved intent adopt the options immediately before create sends them. */
function adoptPairedHostSeed(
  state: StructuredLaunchState,
  seedOptions: StructuredLaunchState['selection']['seed']
): void {
  const { seedOptions: _previous, ...intent } = state.intent
  state.intent = seedOptions ? { ...intent, seedOptions } : intent
  state.selection = { ...state.selection, seed: seedOptions }
  notifyStructuredLaunchListeners()
}

function resetStructuredLaunchCallers(state: StructuredLaunchState): void {
  state.callers = createStructuredLaunchCallerGroup({ kind: 'retry' })
  state.callers.onSettled = () => maybeCleanupLaunchState(state)
}

function restartStructuredLaunchState(state: StructuredLaunchState): void {
  const wasVisibilityUnknown = state.visibilityUnknown
  if (!wasVisibilityUnknown) {
    state.intent = retryStructuredAgentSessionLaunchIntent(state.intent)
  }
  resetStructuredLaunchCallers(state)
  delete state.failure
  state.callers.outcome = 'pending'
  // Retained client choices and picks survive a failed attempt.
  state.selection = { ...state.selection, seed: state.intent.seedOptions }
  state.onHostSeed = (seedOptions) => adoptPairedHostSeed(state, seedOptions)
  state.promise = publishWithHeldOptions(
    state,
    wasVisibilityUnknown ? reconcileUnknownLaunch(state) : launchAndReconcile(state)
  )
  trackLaunchSettlement(state, state.promise)
  notifyStructuredLaunchListeners()
}

function promptOwner(options: StructuredAgentLaunchOptions): { callerKeepsText?: true } {
  return options.promptKeptByCaller ? { callerKeepsText: true } : {}
}

function joinStructuredLaunchState(
  existing: StructuredLaunchState,
  agent: TuiAgent,
  options: StructuredAgentLaunchOptions,
  request: StructuredLaunchRequest
): StructuredLaunchStateResult | undefined {
  // A re-delivery of the same action (a double click) shares the text it staged, so it is sent once.
  const repeat = repeatedStructuredLaunchAttempt(existing.callers.attempt, request.id)
  // An empty chat takes the first text sent to it, delivered the way that request asked.
  const claim = repeat ? undefined : claimableStructuredLaunchAttempt(existing, request)
  const retrying = existing.visibilityUnknown
  const joined = joinLaunchDelivery(
    options,
    claim ? options.promptDelivery : existing.promptDelivery
  )
  // Why: an unconfirmed launch keeps its draft or staged text, so a recheck must not stage it twice.
  const text = retrying || repeat ? '' : launchPromptText(joined)
  const stagedPrompt = text
    ? stageStructuredLaunchPrompt(existing.intent.sessionId, text, promptOwner(options))
    : (repeat?.stagedPrompt ?? null)
  if (retrying) {
    restartStructuredLaunchState(existing)
  }
  if (claim) {
    existing.promptDelivery = options.promptDelivery
    Object.assign(claim, { requestId: request.id, blank: false, stagedPrompt })
  }
  if (!retrying && !repeat) {
    launchDraft.seedStructuredAgentLaunchDraft(existing.intent.sessionId, agent, joined)
  }
  // A re-delivery waits on the text its action staged, if any, and never stages its own.
  const { prompt: _retryPrompt, ...joinedWithoutPrompt } = joined
  const callerOptions = retrying || (repeat && !repeat.stagedPrompt) ? joinedWithoutPrompt : joined
  return {
    state: existing,
    caller: addStructuredLaunchCaller({
      group: existing.callers,
      launchResult: existing.promise,
      target: existing.intent.target,
      options: callerOptions,
      stagedPrompt
    })
  }
}

function structuredAgentLaunchState(
  worktreeId: string,
  agent: TuiAgent,
  options: StructuredAgentLaunchOptions
): StructuredLaunchStateResult {
  const identity = structuredLaunchIdentity(worktreeId, agent, options.resumeFrom)
  const request = structuredLaunchRequest(options)
  const existing = getJoinableStructuredLaunchState(identity, request)
  const joined = existing && joinStructuredLaunchState(existing, agent, options, request)
  if (joined) {
    return joined
  }

  const intent = createStructuredAgentSessionLaunchIntent(
    worktreeId,
    agent,
    options.executionHostId,
    options.resumeFrom,
    options.hostSeedOptions,
    options.clientOptions
  )
  const text = launchPromptText(options)
  const stagedPrompt = text
    ? stageStructuredLaunchPrompt(intent.sessionId, text, promptOwner(options))
    : null
  launchDraft.seedStructuredAgentLaunchDraft(intent.sessionId, agent, options)
  const callers = createStructuredLaunchCallerGroup({
    kind: 'first',
    requestId: request.id,
    blank: !request.hasText,
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
    selection: { seed: intent.seedOptions, held: {} }
  }
  state.onHostSeed = (seedOptions) => adoptPairedHostSeed(state, seedOptions)
  callers.onSettled = () => maybeCleanupLaunchState(state)
  state.promise = publishWithHeldOptions(state, launchAndReconcile(state))
  const caller = addStructuredLaunchCaller({
    group: state.callers,
    launchResult: state.promise,
    target: state.intent.target,
    options,
    stagedPrompt
  })
  setStructuredLaunchState(state)
  notifyStructuredLaunchListeners()
  trackLaunchSettlement(state, state.promise)
  return {
    state,
    caller
  }
}

export function cancelStructuredAgentLaunch(worktreeId: string, sessionId: string): boolean {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (!state) {
    return false
  }
  markStructuredAgentSessionLaunchCancelled(worktreeId, sessionId, state.intent.executionHostId)
  discardStructuredAgentSessionChatSends(state.intent.sessionId)
  launchDraft.clearStructuredAgentLaunchDraft(state.intent.sessionId)
  abandonStructuredAgentSessionLaunchIntent(state.intent)
  notifyStructuredLaunchListeners()
  return true
}

export function startStructuredAgentLaunch(
  worktreeId: string,
  agent: TuiAgent,
  options: StructuredAgentLaunchOptions
): StructuredAgentLaunchResult {
  const { state, caller } = structuredAgentLaunchState(worktreeId, agent, options)
  return {
    sessionId: state.intent.sessionId,
    executionHostId: state.intent.executionHostId,
    launchResult: state.promise,
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
    (!state.visibilityUnknown && state.callers.outcome !== 'failed')
  ) {
    return false
  }
  restartStructuredLaunchState(state)
  return true
}

/** A message sent to a chat whose start never published relaunches it. Shared by the chat's
 *  composer and by messages sent from elsewhere. */
export function relaunchFailedStructuredAgentSessionForMessage(
  worktreeId: string,
  sessionId: string
): void {
  if (getStructuredAgentSessionLaunchLifecycle(worktreeId, sessionId) === 'failed') {
    retryStructuredAgentSessionLaunch(worktreeId, sessionId)
  }
}
