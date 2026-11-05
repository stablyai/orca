import type {
  AntigravityChatAuth,
  AntigravityChatSignInIntent,
  AntigravityChatSignInState,
  AntigravityChatSignInStartResult,
  AntigravityChatSignInStatus
} from '../../../shared/antigravity-account-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { onRuntimeEnvironmentsRetired } from './runtime-environment-revision'
import {
  createRevisionedHostStateStore,
  type RevisionedHostSnapshot
} from './revisioned-host-state-store'
import {
  callAntigravityChatSignIn,
  subscribeAntigravityChatSignIn
} from './runtime-antigravity-accounts-client'

/**
 * Each host's Antigravity chat sign-in, followed like an install's status: every Settings row for
 * a host shows the same flow and the server's last sign-in answer, from another client's flow too.
 */

export type AntigravityChatSignInView = {
  /** Whether the host has answered; `readFailed` says nothing about the sign-in. */
  status: RevisionedHostSnapshot<AntigravityChatSignInStatus>['kind']
  flow: AntigravityChatSignInState | null
  auth: AntigravityChatAuth
  /** Why this client's last request failed; empty when it gave no reason. */
  error: string | null
  /** The browser could not open the link this client asked for. */
  openFailed: boolean
  retryIntent: AntigravityChatSignInIntent
}

type HostStatus = AntigravityChatSignInStatus & { runtimeId?: string }

type Notes = Pick<AntigravityChatSignInView, 'error' | 'openFailed'> & {
  attempt: {
    intent: AntigravityChatSignInIntent
    previousFlow: string | null | undefined
    previousRuntime: string | undefined
    accepted?: { flowId: string; runtimeId: string }
    receipt?: HostStatus
  } | null
}
type Local = {
  owner: RuntimeClientTarget
  observers: number
  /** The flow this client started while shown, whose link it opens once. */
  opens: string | null
  starts: number
  notes: Notes
}

const NO_NOTES: Notes = { error: null, openFailed: false, attempt: null }
const hostKey = (owner: RuntimeClientTarget): string =>
  owner.kind === 'local' ? '' : owner.environmentId

const signIns = createRevisionedHostStateStore<RuntimeClientTarget, HostStatus>({
  key: hostKey,
  hostKey,
  subscribe: subscribeAntigravityChatSignIn
})
const locals = new Map<string, Local>()
type Shown = {
  snapshot: RevisionedHostSnapshot<HostStatus>
  notes: Notes
  view: AntigravityChatSignInView
}
const views = new Map<string, Shown>()
const listeners = new Set<() => void>()

export const antigravityChatSignInRunning = (
  flow: AntigravityChatSignInState | null
): flow is AntigravityChatSignInState =>
  flow?.phase === 'starting' || flow?.phase === 'waiting' || flow?.phase === 'verifying'

const observed = (owner: RuntimeClientTarget): HostStatus | null => {
  const snapshot = signIns.read(owner)
  return snapshot.kind === 'known' ? snapshot.state : null
}
const stateFor = (owner: RuntimeClientTarget): HostStatus | null =>
  locals.get(hostKey(owner))?.notes.attempt?.receipt ?? observed(owner)
const flowOf = (owner: RuntimeClientTarget): AntigravityChatSignInState | null =>
  stateFor(owner)?.flow ?? null

function reconcile(local: Local): void {
  const attempt = local.notes.attempt
  const state = observed(local.owner)
  if (!attempt || !state) {
    return
  }
  const receipt = attempt.receipt
  const displaced =
    attempt.accepted &&
    state.runtimeId !== undefined &&
    state.runtimeId !== attempt.accepted.runtimeId &&
    state.runtimeId !== attempt.previousRuntime
  const incorporated = receipt
    ? state.runtimeId === receipt.runtimeId && state.revision >= receipt.revision
    : state.flow?.flowId &&
      (state.flow.flowId === attempt.accepted?.flowId || state.flow.flowId !== attempt.previousFlow)
  if (displaced || incorporated) {
    local.notes = { ...local.notes, attempt: null }
  }
}

function localFor(owner: RuntimeClientTarget): Local {
  let local = locals.get(hostKey(owner))
  if (!local) {
    local = { owner, observers: 0, opens: null, starts: 0, notes: NO_NOTES }
    locals.set(hostKey(owner), local)
  }
  return local
}

function note(local: Local, patch: Partial<Notes>): void {
  local.notes = { ...local.notes, ...patch }
  reconcile(local)
  listeners.forEach((listener) => listener())
}

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : '')

/** Opens the link of a flow this client started, once, when the host first shows it. */
function openStartedLinks(): void {
  for (const local of locals.values()) {
    const flow = flowOf(local.owner)
    if (local.opens && flow?.flowId === local.opens && flow.phase === 'waiting' && flow.url) {
      const { flowId } = flow
      local.opens = null
      void window.api.shell.openUrl(flow.url).catch(() => {
        if (flowOf(local.owner)?.flowId === flowId) {
          note(local, { openFailed: true })
        }
      })
    }
  }
}
signIns.subscribe(() => {
  locals.forEach(reconcile)
  openStartedLinks()
})
onRuntimeEnvironmentsRetired((ids) => {
  for (const id of ids) {
    const local = locals.get(id)
    if (local) {
      local.starts += 1
      local.opens = null
      note(local, NO_NOTES)
    }
  }
})

/** Starts a sign-in on the host, or rejoins this client's running one; the host's status shows it. */
export async function startAntigravityChatSignIn(
  owner: RuntimeClientTarget,
  intent: AntigravityChatSignInIntent
): Promise<void> {
  const local = localFor(owner)
  const ticket = ++local.starts
  const baseline = stateFor(owner)
  const attempt = {
    intent,
    previousFlow: baseline?.flow?.flowId,
    previousRuntime: baseline?.runtimeId
  }
  note(local, { ...NO_NOTES, attempt })
  try {
    const { result, _meta } = await callAntigravityChatSignIn<AntigravityChatSignInStartResult>(
      owner,
      'Start',
      { intent }
    )
    if (ticket === local.starts) {
      const current = observed(owner)
      if (
        attempt.previousRuntime !== undefined &&
        current?.runtimeId !== undefined &&
        current.runtimeId !== attempt.previousRuntime &&
        current.runtimeId !== _meta.runtimeId
      ) {
        note(local, { attempt: null })
        return
      }
      local.opens = local.observers > 0 ? result.flowId : null
      note(local, {
        attempt: {
          ...attempt,
          previousRuntime: attempt.previousRuntime ?? current?.runtimeId,
          accepted: { flowId: result.flowId, runtimeId: _meta.runtimeId },
          ...(result.status ? { receipt: { ...result.status, runtimeId: _meta.runtimeId } } : {})
        }
      })
      openStartedLinks()
    }
  } catch (cause) {
    if (ticket === local.starts) {
      note(local, { error: message(cause) })
    }
  }
}

/** Only the client that started a flow is told its id, so only it can cancel or complete it. */
const ownFlowId = (owner: RuntimeClientTarget): string | null => flowOf(owner)?.flowId ?? null

export async function cancelAntigravityChatSignIn(owner: RuntimeClientTarget): Promise<void> {
  const flowId = ownFlowId(owner)
  if (flowId) {
    await callAntigravityChatSignIn(owner, 'Cancel', { flowId }).catch((cause: unknown) =>
      note(localFor(owner), { error: message(cause) })
    )
  }
}

/** Sends the address the browser ended on to the host, for a browser on another computer.
 *  Resolves to the host's refusal, empty when it gave no reason, or null once it took it. */
export async function completeAntigravityChatSignIn(
  owner: RuntimeClientTarget,
  callbackUrl: string
): Promise<string | null> {
  const flowId = ownFlowId(owner)
  if (!flowId) {
    return ''
  }
  return callAntigravityChatSignIn(owner, 'Complete', { flowId, callbackUrl }).then(
    () => null,
    message
  )
}

/** Follows the host's sign-in while a row shows it. Returns the release. */
export function observeAntigravityChatSignIn(owner: RuntimeClientTarget): () => void {
  const local = localFor(owner)
  local.observers += 1
  const release = signIns.observe(owner)
  return () => {
    release()
    local.observers -= 1
    if (local.observers === 0) {
      local.opens = null
    }
  }
}

export function readAntigravityChatSignIn(owner: RuntimeClientTarget): AntigravityChatSignInView {
  const snapshot = signIns.read(owner)
  const notes = locals.get(hostKey(owner))?.notes ?? NO_NOTES
  const cached = views.get(hostKey(owner))
  if (cached?.snapshot === snapshot && cached.notes === notes) {
    return cached.view
  }
  const known = stateFor(owner)
  const view = {
    status: known ? ('known' as const) : snapshot.kind,
    flow: known?.flow ?? null,
    auth: known?.auth ?? 'unknown',
    error: notes.error,
    openFailed: notes.openFailed,
    retryIntent: notes.attempt?.receipt
      ? (notes.attempt.receipt.flow?.intent ?? 'signIn')
      : (notes.attempt?.intent ?? known?.flow?.intent ?? 'signIn')
  }
  views.set(hostKey(owner), { snapshot, notes, view })
  return view
}

export function subscribeAntigravityChatSignIns(listener: () => void): () => void {
  listeners.add(listener)
  const unsubscribe = signIns.subscribe(listener)
  return () => {
    listeners.delete(listener)
    unsubscribe()
  }
}
