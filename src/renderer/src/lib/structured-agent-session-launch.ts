import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import {
  abandonStructuredAgentSessionLaunchIntent,
  createStructuredAgentSessionLaunchIntent,
  retryStructuredAgentSessionLaunchIntent,
  StructuredAgentSessionCreateRefusalError
} from '@/lib/launch-structured-agent-session'
import {
  discardStructuredAgentSessionLaunchOutbox,
  enqueueStructuredAgentSessionLaunchPrompt
} from '@/components/native-chat/structured-agent-session-outbox-storage'
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
  getJoinableStructuredLaunchState,
  getStructuredAgentSessionLaunchLifecycle,
  getStructuredLaunchStateBySessionId,
  markStructuredAgentSessionLaunchCancelled,
  notifyStructuredLaunchListeners,
  setStructuredLaunchState,
  structuredLaunchIdentity,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'
import { restorePersistedStructuredLaunchState } from './structured-agent-session-launch-reload'
import { applyStructuredLaunchHeldOptions } from './structured-agent-session-launch-options'
import { trackLaunchSettlement } from './structured-agent-session-launch-outcome-tracking'

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

/** What the outbox must carry: a draft goes to the composer seed instead. */
function outboxPromptText(options: StructuredAgentLaunchOptions): string {
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

/** Each attempt's probe names the seed the paired server's create will use; the picker shows it. */
function adoptPairedHostSeed(
  state: StructuredLaunchState,
  seedOptions: StructuredLaunchState['selection']['seed']
): void {
  if (JSON.stringify(seedOptions) === JSON.stringify(state.intent.seedOptions)) {
    return
  }
  const { seedOptions: _previous, ...intent } = state.intent
  state.intent = seedOptions ? { ...intent, seedOptions } : intent
  state.selection = { ...state.selection, seed: seedOptions }
  notifyStructuredLaunchListeners()
}

function resetStructuredLaunchCallers(state: StructuredLaunchState): void {
  state.callers = createStructuredLaunchCallerGroup()
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
  // A new create seeds from the settings of now (a paired server's arrive with its probe); picks
  // held through the failure still apply.
  state.selection = { ...state.selection, seed: state.intent.seedOptions }
  state.onHostSeed = (seedOptions) => adoptPairedHostSeed(state, seedOptions)
  state.promise = publishWithHeldOptions(
    state,
    wasVisibilityUnknown ? reconcileUnknownLaunch(state) : launchAndReconcile(state)
  )
  trackLaunchSettlement(state, state.promise)
  notifyStructuredLaunchListeners()
}

function structuredAgentLaunchState(
  worktreeId: string,
  agent: AgentSessionHandleProvider,
  options: StructuredAgentLaunchOptions
): StructuredLaunchStateResult {
  const identity = structuredLaunchIdentity(worktreeId, agent, options.resumeFrom)
  const existing = getJoinableStructuredLaunchState(identity)
  if (existing) {
    const retrying = existing.visibilityUnknown
    if (retrying) {
      restartStructuredLaunchState(existing)
    }
    const joined = joinLaunchDelivery(options, existing.promptDelivery)
    // Why: an unconfirmed launch keeps its draft/outbox, so a recheck must not stage it twice.
    const text = retrying ? '' : outboxPromptText(joined)
    const stagedPrompt = text
      ? enqueueStructuredAgentSessionLaunchPrompt(existing.intent.sessionId, text)
      : null
    if (!retrying) {
      launchDraft.seedStructuredAgentLaunchDraft(existing.intent.sessionId, agent, joined)
    }
    const { prompt: _retryPrompt, ...joinedWithoutPrompt } = joined
    const callerOptions = retrying ? joinedWithoutPrompt : joined
    return {
      state: existing,
      caller: addStructuredLaunchCaller({
        group: existing.callers,
        launchResult: existing.promise,
        target: existing.intent.target,
        options: callerOptions,
        stagedEntry: stagedPrompt
      })
    }
  }

  const intent = createStructuredAgentSessionLaunchIntent(
    worktreeId,
    agent,
    options.executionHostId,
    options.resumeFrom,
    options.hostSeedOptions
  )
  const text = outboxPromptText(options)
  const stagedPrompt = text
    ? enqueueStructuredAgentSessionLaunchPrompt(intent.sessionId, text)
    : null
  launchDraft.seedStructuredAgentLaunchDraft(intent.sessionId, agent, options)
  const callers = createStructuredLaunchCallerGroup()
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
  state.promise =
    text && !stagedPrompt
      ? Promise.reject(
          new StructuredAgentSessionCreateRefusalError(
            `Could not durably stage the ${structuredAgentLabel(agent)} launch prompt.`
          )
        )
      : publishWithHeldOptions(state, launchAndReconcile(state))
  const caller = addStructuredLaunchCaller({
    group: state.callers,
    launchResult: state.promise,
    target: state.intent.target,
    options,
    stagedEntry: stagedPrompt
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
  discardStructuredAgentSessionLaunchOutbox(state.intent.sessionId)
  launchDraft.clearStructuredAgentLaunchDraft(state.intent.sessionId)
  abandonStructuredAgentSessionLaunchIntent(state.intent)
  notifyStructuredLaunchListeners()
  return true
}

export function startStructuredAgentLaunch(
  worktreeId: string,
  agent: AgentSessionHandleProvider,
  options: StructuredAgentLaunchOptions = {}
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

/** A message queued on a chat whose start never published relaunches it; the message goes out on
 *  publish. Shared by the chat's composer and by messages sent from elsewhere. */
export function relaunchFailedStructuredAgentSessionForMessage(
  worktreeId: string,
  sessionId: string
): void {
  if (getStructuredAgentSessionLaunchLifecycle(worktreeId, sessionId) === 'failed') {
    retryStructuredAgentSessionLaunch(worktreeId, sessionId)
  }
}
