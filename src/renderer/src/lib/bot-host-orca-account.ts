// Each bot host's own Orca sign-in as that host reports it (`orcaAccount.*`), and the one
// "Sign <server> in to Orca" per host: the host starts an approve-in-browser sign-in, this window
// opens its page where that host's own pages open, and the host finishes on its own.
import { useEffect, useSyncExternalStore } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import {
  isOrcaAccountApprovalPrompt,
  type OrcaAccountApprovalPrompt,
  type OrcaAccountServerStatus,
  type OrcaAccountSignInStatus
} from '../../../shared/orca-account-server-sign-in'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import { useAppStore } from '@/store'
import { botHostTarget, type BotRef } from './bot-hosts'
import { recomputeOn } from './recompute-on'
import { openBotHostPageOrSay } from './bot-host-page'
import { refreshBotHost } from './bot-host-refresh'
import { onBotsChanged } from './bots-changed-window-event'

/** The host's sign-in from this window: none, its page waiting on approval, or why it stopped. */
export type BotHostSignInView =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'waiting'; prompt: OrcaAccountApprovalPrompt }
  | { phase: 'failed'; error: string }

type HostEntry = {
  status: OrcaAccountServerStatus | null
  // A read has finished, so a null status means unknown rather than not read yet.
  settled: boolean
  reading: Promise<void> | null
  signIn: BotHostSignInView
  // The flow this window started; a newer start or a cancel replaces it.
  flowId: string | null
}

// The wait answers when the flow changes; past this a paired call ends and the wait asks again.
const WAIT_TIMEOUT_MS = 60_000
const RETRY_MS = 2_000
const IDLE: BotHostSignInView = { phase: 'idle' }

const hosts = new Map<ExecutionHostId, HostEntry>()
const listeners = new Set<() => void>()
// Bumped on every change, so a view over several hosts re-reads them together.
let version = 0

function entryOf(hostId: ExecutionHostId): HostEntry {
  let entry = hosts.get(hostId)
  if (!entry) {
    entry = { status: null, settled: false, reading: null, signIn: IDLE, flowId: null }
    hosts.set(hostId, entry)
  }
  return entry
}

function notify(): void {
  version++
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Reads the host's sign-in again; an older Orca without `orcaAccount.status` reads as unknown. */
export function refreshBotHostOrcaAccount(hostId: ExecutionHostId): Promise<void> {
  const entry = entryOf(hostId)
  entry.reading ??= callRuntimeRpc<OrcaAccountServerStatus>(
    botHostTarget(hostId),
    'orcaAccount.status'
  )
    .then(
      (status) => {
        entry.status = status
      },
      () => {
        entry.status = null
      }
    )
    .finally(() => {
      entry.reading = null
      entry.settled = true
      notify()
    })
  return entry.reading
}

/** The host's Orca sign-in, read when shown and again when its bots change (a sign-in change re-lists them). */
export function useBotHostOrcaAccount(hostId: ExecutionHostId): OrcaAccountServerStatus | null {
  const status = useSyncExternalStore(subscribe, () => hosts.get(hostId)?.status ?? null)
  useEffect(() => {
    void refreshBotHostOrcaAccount(hostId)
    return onBotsChanged(() => void refreshBotHostOrcaAccount(hostId), hostId, {
      kinds: ['settings', 'bot']
    })
  }, [hostId])
  return status
}

/** Whether the host's sign-in has been read at least once; before that its status is null for want of a read. */
export function useBotHostOrcaAccountSettled(hostId: ExecutionHostId): boolean {
  return useSyncExternalStore(subscribe, () => hosts.get(hostId)?.settled ?? false)
}

/** Whether the host runs as this window's own Orca account; this app's own bots always do. */
export function useBotHostOnOwnAccount(hostId: ExecutionHostId): boolean {
  const account = useBotHostOrcaAccount(hostId)
  const ownEmail = useAppStore((state) => state.orcaProfileAuthStatus?.cloud?.email ?? null)
  return (
    hostId === LOCAL_EXECUTION_HOST_ID ||
    (account?.state === 'signed-in' && !!account.email && account.email === ownEmail)
  )
}

/** The last read of several hosts' sign-ins, in order; each host's own `useBotHostOrcaAccount` reads it. */
export function useBotHostOrcaAccounts(
  hostIds: readonly ExecutionHostId[]
): (OrcaAccountServerStatus | null)[] {
  const seen = useSyncExternalStore(subscribe, () => version)
  return recomputeOn([seen], () => hostIds.map((hostId) => hosts.get(hostId)?.status ?? null))
}

export function useBotHostSignIn(hostId: ExecutionHostId): BotHostSignInView {
  return useSyncExternalStore(subscribe, () => hosts.get(hostId)?.signIn ?? IDLE)
}

function setSignIn(hostId: ExecutionHostId, view: BotHostSignInView): void {
  entryOf(hostId).signIn = view
  notify()
}

/**
 * "Sign <server> in to Orca" / "Sign <server> in again": any account; Orca Cloud's page warns
 * before it moves the host to another one. `bot` lends its workspace for the host's page.
 */
export async function startBotHostSignIn(hostId: ExecutionHostId, bot?: BotRef): Promise<void> {
  const entry = entryOf(hostId)
  setSignIn(hostId, { phase: 'starting' })
  let flow: OrcaAccountSignInStatus
  try {
    flow = await callRuntimeRpc<OrcaAccountSignInStatus>(
      botHostTarget(hostId),
      'orcaAccount.signIn.start',
      { approveInBrowser: true, switchAccount: false }
    )
  } catch (error) {
    setSignIn(hostId, { phase: 'failed', error: messageOf(error) })
    return
  }
  entry.flowId = flow.flowId
  await follow(hostId, flow, bot)
}

/** Follows the host's flow until it settles, opening its page once it has one. */
async function follow(
  hostId: ExecutionHostId,
  from: OrcaAccountSignInStatus,
  bot: BotRef | undefined
): Promise<void> {
  const entry = entryOf(hostId)
  let flow = from
  let opened = false
  while (entry.flowId === flow.flowId) {
    if (flow.phase === 'signedIn') {
      entry.flowId = null
      setSignIn(hostId, IDLE)
      await Promise.all([refreshBotHostOrcaAccount(hostId), refreshBotHost(hostId)])
      return
    }
    if (flow.phase === 'failed' || flow.phase === 'cancelled') {
      entry.flowId = null
      setSignIn(
        hostId,
        flow.phase === 'failed' ? { phase: 'failed', error: flow.error ?? '' } : IDLE
      )
      void refreshBotHostOrcaAccount(hostId)
      return
    }
    if (flow.phase === 'waiting' && isOrcaAccountApprovalPrompt(flow.prompt)) {
      if (!opened) {
        opened = true
        // Only the server's own session: this computer's browser has this computer's logins.
        if (
          openBotHostPageOrSay(hostId, flow.prompt.verificationUrl, { bot, local: 'system' }) ===
          'unrouted'
        ) {
          cancelBotHostSignIn(hostId)
          return
        }
      }
      setSignIn(hostId, { phase: 'waiting', prompt: flow.prompt })
    }
    const next = await callRuntimeRpc<OrcaAccountSignInStatus>(
      botHostTarget(hostId),
      'orcaAccount.signIn.wait',
      { flowId: flow.flowId, afterRevision: flow.revision },
      { timeoutMs: WAIT_TIMEOUT_MS }
    ).catch(() => null)
    if (next) {
      flow = next
    } else {
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
    }
  }
}

/** Stops waiting here and ends the host's flow; the browser page is left as is. */
export function cancelBotHostSignIn(hostId: ExecutionHostId): void {
  const entry = entryOf(hostId)
  const { flowId } = entry
  entry.flowId = null
  setSignIn(hostId, IDLE)
  if (flowId) {
    void callRuntimeRpc(botHostTarget(hostId), 'orcaAccount.signIn.cancel', { flowId }).catch(
      () => undefined
    )
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
