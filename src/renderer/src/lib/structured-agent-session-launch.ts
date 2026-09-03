import { toast } from 'sonner'
import {
  createStructuredCodexSessionLaunchIntent,
  abandonStructuredAgentSessionLaunchIntent,
  launchStructuredCodexSession,
  StructuredAgentSessionCreateRefusalError,
  type StructuredAgentSessionLaunchIntent
} from '@/lib/launch-structured-codex-session'
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync'
import { translate } from '@/i18n/i18n'

type StructuredLaunchState = {
  intent: StructuredAgentSessionLaunchIntent
  promise: Promise<string>
  visibilityUnknown: boolean
  cancelled: boolean
}

const pendingStructuredLaunchesByWorktree = new Map<string, StructuredLaunchState>()

class StructuredAgentSessionLaunchCancelledError extends Error {
  constructor() {
    super('structured session launch cancelled')
    this.name = 'StructuredAgentSessionLaunchCancelledError'
  }
}

function throwIfLaunchCancelled(state: StructuredLaunchState): void {
  if (state.cancelled) {
    throw new StructuredAgentSessionLaunchCancelledError()
  }
}

function trackLaunchSettlement(
  worktreeId: string,
  state: StructuredLaunchState,
  promise: Promise<string>
): void {
  void promise.then(
    () => {
      if (
        state.promise === promise &&
        pendingStructuredLaunchesByWorktree.get(worktreeId) === state
      ) {
        pendingStructuredLaunchesByWorktree.delete(worktreeId)
      }
    },
    () => {
      if (
        state.promise === promise &&
        !state.visibilityUnknown &&
        pendingStructuredLaunchesByWorktree.get(worktreeId) === state
      ) {
        pendingStructuredLaunchesByWorktree.delete(worktreeId)
      }
    }
  )
}

async function verifyPublishedSession(intent: StructuredAgentSessionLaunchIntent): Promise<string> {
  const snapshots = await refreshLocalStructuredSessionTabs()
  const published = snapshots.some(
    (snapshot) =>
      snapshot.worktree === intent.worktreeId &&
      snapshot.tabs.some(
        (tab) => tab.type === 'agent-session' && tab.sessionId === intent.sessionId
      )
  )
  if (!published) {
    throw new Error('structured session tab publication unavailable')
  }
  return intent.sessionId
}

async function retrySameIntent(state: StructuredLaunchState, priorError: unknown): Promise<string> {
  throwIfLaunchCancelled(state)
  try {
    await launchStructuredCodexSession(state.intent)
    throwIfLaunchCancelled(state)
    return await verifyPublishedSession(state.intent)
  } catch (error) {
    if (state.cancelled) {
      throw new StructuredAgentSessionLaunchCancelledError()
    }
    if (error instanceof StructuredAgentSessionCreateRefusalError) {
      throw error
    }
    try {
      return await verifyPublishedSession(state.intent)
    } catch {
      state.visibilityUnknown = true
      throw error ?? priorError
    }
  }
}

async function launchAndReconcile(state: StructuredLaunchState): Promise<string> {
  throwIfLaunchCancelled(state)
  try {
    await launchStructuredCodexSession(state.intent)
  } catch (error) {
    if (state.cancelled) {
      throw new StructuredAgentSessionLaunchCancelledError()
    }
    if (error instanceof StructuredAgentSessionCreateRefusalError) {
      throw error
    }
    try {
      return await verifyPublishedSession(state.intent)
    } catch {
      return retrySameIntent(state, error)
    }
  }
  try {
    throwIfLaunchCancelled(state)
    return await verifyPublishedSession(state.intent)
  } catch (error) {
    if (state.cancelled) {
      throw new StructuredAgentSessionLaunchCancelledError()
    }
    return retrySameIntent(state, error)
  }
}

async function reconcileUnknownLaunch(state: StructuredLaunchState): Promise<string> {
  throwIfLaunchCancelled(state)
  state.visibilityUnknown = false
  try {
    return await verifyPublishedSession(state.intent)
  } catch (error) {
    return retrySameIntent(state, error)
  }
}

function launchStructuredCodexSessionOnce(worktreeId: string): Promise<string> {
  const existing = pendingStructuredLaunchesByWorktree.get(worktreeId)
  if (existing) {
    if (existing.visibilityUnknown) {
      existing.promise = reconcileUnknownLaunch(existing)
      trackLaunchSettlement(worktreeId, existing, existing.promise)
    }
    return existing.promise
  }
  const state: StructuredLaunchState = {
    intent: createStructuredCodexSessionLaunchIntent(worktreeId),
    promise: Promise.resolve(''),
    visibilityUnknown: false,
    cancelled: false
  }
  state.promise = launchAndReconcile(state)
  pendingStructuredLaunchesByWorktree.set(worktreeId, state)
  trackLaunchSettlement(worktreeId, state, state.promise)
  return state.promise
}

/** Stop retries for a launch whose tab the user explicitly closed. */
export function cancelStructuredCodexLaunch(worktreeId: string, sessionId: string): boolean {
  const state = pendingStructuredLaunchesByWorktree.get(worktreeId)
  if (!state || state.intent.sessionId !== sessionId) {
    return false
  }
  state.cancelled = true
  pendingStructuredLaunchesByWorktree.delete(worktreeId)
  abandonStructuredAgentSessionLaunchIntent(state.intent)
  return true
}

export function startStructuredCodexLaunch(worktreeId: string): void {
  void launchStructuredCodexSessionOnce(worktreeId).catch((error) => {
    if (error instanceof StructuredAgentSessionLaunchCancelledError) {
      return
    }
    toast.error(
      translate(
        'components.native-chat.structuredSessionLaunchFailed',
        'Could not open Codex chat'
      ),
      { description: error instanceof Error ? error.message : String(error) }
    )
  })
}
