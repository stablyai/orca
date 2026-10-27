import type {
  AntigravityChatAuth,
  AntigravityChatSignInState,
  AntigravityChatSignInStatus
} from '../../../shared/antigravity-account-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
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
}

type Notes = Pick<AntigravityChatSignInView, 'error' | 'openFailed'>
type Local = {
  owner: RuntimeClientTarget
  observers: number
  /** The flow this client started while shown, whose link it opens once. */
  opens: string | null
  starts: number
  notes: Notes
}

const NO_NOTES: Notes = { error: null, openFailed: false }
const hostKey = (owner: RuntimeClientTarget): string =>
  owner.kind === 'local' ? '' : owner.environmentId

const signIns = createRevisionedHostStateStore<RuntimeClientTarget, AntigravityChatSignInStatus>({
  key: hostKey,
  hostKey,
  subscribe: subscribeAntigravityChatSignIn
})
const locals = new Map<string, Local>()
type Shown = {
  snapshot: RevisionedHostSnapshot<AntigravityChatSignInStatus>
  notes: Notes
  view: AntigravityChatSignInView
}
const views = new Map<string, Shown>()
const listeners = new Set<() => void>()

export const antigravityChatSignInRunning = (
  flow: AntigravityChatSignInState | null
): flow is AntigravityChatSignInState =>
  flow?.phase === 'starting' || flow?.phase === 'waiting' || flow?.phase === 'verifying'

const flowOf = (owner: RuntimeClientTarget): AntigravityChatSignInState | null => {
  const snapshot = signIns.read(owner)
  return snapshot.kind === 'known' ? snapshot.state.flow : null
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
signIns.subscribe(openStartedLinks)

/** Starts a sign-in on the host, or rejoins this client's running one; the host's status shows it. */
export async function startAntigravityChatSignIn(owner: RuntimeClientTarget): Promise<void> {
  const local = localFor(owner)
  const ticket = ++local.starts
  note(local, NO_NOTES)
  try {
    const { flowId } = await callAntigravityChatSignIn<{ flowId: string }>(owner, 'Start')
    // A row that left before the host answered opens nothing; one shown later shows the flow.
    if (ticket === local.starts) {
      local.opens = local.observers > 0 ? flowId : null
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
  const known = snapshot.kind === 'known' ? snapshot.state : null
  const view = {
    status: snapshot.kind,
    flow: known?.flow ?? null,
    auth: known?.auth ?? 'unknown',
    ...notes
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
