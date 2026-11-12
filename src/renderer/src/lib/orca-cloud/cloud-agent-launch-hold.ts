// Orca Cloud launches decided from the Orca account, never the sandbox (agent-sign-in redesign §13).
// Ready: no hold. Expired or revoked with no key: the pane holds on the account-recovery strip
// (S4-c, card 13) until Renew in S0 fixes it for every workspace. Not set up with no key (PC-3b):
// the pane holds on the "Set up once" strip, which runs S0 inline and then offers "Start {{agent}}".
// Kill switch or a provider never offered: no hold here; the per-workspace sign-in (#40228's gate)
// runs and the strip shows it.
import { useSyncExternalStore } from 'react'
import type { HostAgentSignInAgent } from '../../../../shared/host-agent-sign-in-status'
import { orcaCloudAgentCoverageFromAccounts } from './orca-cloud-agent-accounts-model'
import {
  ensureFreshOrcaCloudAgentAccounts,
  isOrcaCloudAgentAccountsFresh,
  readOrcaCloudAgentAccounts,
  subscribeOrcaCloudAgentAccounts,
  type OrcaCloudAgentAccountsState
} from './orca-cloud-agent-accounts-store'

/** Why a cloud pane shows the strip: account recovery, or the per-workspace fallback. */
export type CloudAgentStripReason = 'accountExpired' | 'paused' | 'notOffered'

export function cloudAgentStripReason(
  agent: HostAgentSignInAgent,
  accounts: Pick<OrcaCloudAgentAccountsState, 'load' | 'keyKinds'>
): CloudAgentStripReason | null {
  switch (orcaCloudAgentCoverageFromAccounts(agent, accounts)?.kind) {
    case undefined:
      return null
    case 'expired':
      return 'accountExpired'
    case 'killSwitch':
      return 'paused'
    case 'unavailable':
      return 'notOffered'
    case 'account':
    case 'key':
    case 'notSetUp':
      return null
  }
}

/** Why a launch is held: account recovery, or the one-time setup (PC-3b). */
export type CloudAgentHoldReason =
  | 'accountExpired'
  | 'notSetUp'
  /**
   * V3-01: a hold put back after a restart whose account now covers the agent (or whose read
   * failed): it waits for the person's Start. Never labelled "not set up" or "expired".
   */
  | 'awaitingStart'

/** The hold a launch needs from this accounts read; null starts it. */
export function cloudAgentHoldReason(
  agent: HostAgentSignInAgent,
  accounts: Pick<OrcaCloudAgentAccountsState, 'load' | 'keyKinds'>
): CloudAgentHoldReason | null {
  switch (orcaCloudAgentCoverageFromAccounts(agent, accounts)?.kind) {
    case undefined:
      return null
    case 'expired':
      return 'accountExpired'
    case 'notSetUp':
      return 'notSetUp'
    case 'account':
    case 'key':
    case 'killSwitch':
    case 'unavailable':
      return null
  }
  // A coverage kind added later starts the launch rather than holding on an unknown state.
  return null
}

/**
 * For the composer (PC-3b): would a cloud launch of this agent hold right now? 'unknown' while the
 * account read is loading; such a launch holds until the read answers, so creating with the agent
 * never reaches the agent's own /login.
 */
export function cloudAgentLaunchHoldReason(
  agent: HostAgentSignInAgent
): CloudAgentHoldReason | 'unknown' | null {
  const accounts = readOrcaCloudAgentAccounts()
  return accounts.load.kind === 'loading' ? 'unknown' : cloudAgentHoldReason(agent, accounts)
}

export type CloudAgentHold = {
  paneKey: string
  agent: HostAgentSignInAgent
  prompt: string | null
  reason: CloudAgentHoldReason
  /**
   * Why an 'awaitingStart' hold waits: the account covers the agent now, Orca couldn't read it,
   * or an expired sign-in was renewed (V3-01). Absent for every other reason.
   */
  awaiting?: 'covered' | 'unread' | 'renewed'
}

/** The hold key of a host-published tab (RA-1): its first pane shows the strip. */
export function cloudTabHoldKey(tabId: string): string {
  return `tab:${tabId}`
}

type HoldRequest = Omit<CloudAgentHold, 'reason' | 'awaiting'> & {
  /** The caller already read the account and decided to hold; skip the re-read. */
  decided?: boolean
  /**
   * V3-01: a hold put back after a restart always waits for the person's explicit Start: a covered
   * account (or a failed read) holds as 'awaitingStart', and an expired one that is then renewed
   * turns 'awaitingStart' instead of starting. In-session holds keep their behaviour.
   */
  restored?: boolean
}

type Entry = CloudAgentHold & { release: (outcome: 'proceed' | 'cancel') => void }

const holds = new Map<string, Entry>()
const listeners = new Set<() => void>()

/** Every current hold, as one stable snapshot for subscribers (rebuilt on each change). */
let holdsSnapshot: readonly CloudAgentHold[] = []

function notify(): void {
  holdsSnapshot = [...holds.values()].map(({ paneKey, agent, prompt, reason, awaiting }) => ({
    paneKey,
    agent,
    prompt,
    reason,
    ...(awaiting ? { awaiting } : {})
  }))
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useCloudAgentHold(paneKey: string): CloudAgentHold | null {
  return useSyncExternalStore(
    subscribe,
    () => holds.get(paneKey) ?? null,
    () => null
  )
}

/** All held launches (N-03: the sidebar row marks a workspace whose agent waits on its strip). */
export function useCloudAgentHolds(): readonly CloudAgentHold[] {
  return useSyncExternalStore(
    subscribe,
    () => holdsSnapshot,
    () => holdsSnapshot
  )
}

/** The tab a hold's pane key belongs to: `tab:<id>` for a host tab, else `<tabId>:<leaf>`. */
export function cloudAgentHoldTabId(paneKey: string): string {
  return paneKey.startsWith('tab:') ? paneKey.slice(4) : (paneKey.split(':')[0] ?? paneKey)
}

export function readCloudAgentHold(paneKey: string): CloudAgentHold | null {
  return holds.get(paneKey) ?? null
}

export function releaseCloudAgentHold(paneKey: string, outcome: 'proceed' | 'cancel'): void {
  const hold = holds.get(paneKey)
  if (hold && outcome === 'proceed') {
    // The strip's Start: the person asked for the agent here and now (a Renew's auto-start didn't).
    startedByPerson.add(paneKey)
  }
  hold?.release(outcome)
}

const startedByPerson = new Set<string>()

/** Whether this hold was released by the person's Start (read once): its agent should take focus. */
export function takeCloudAgentHoldStartedByPerson(paneKey: string): boolean {
  return startedByPerson.delete(paneKey)
}

// A launch decides within this budget; a slow or failed read never holds the agent.
const DECIDE_BUDGET_MS = 3_000

/**
 * The cached read decides synchronously (no delay for a ready account): true holds, false starts.
 * 'unknown' means nothing is cached yet, so the launch reads once within a short budget.
 */
export function cloudAgentLaunchNeedsHold(agent: HostAgentSignInAgent): boolean | 'unknown' {
  const accounts = readOrcaCloudAgentAccounts()
  // Only a fresh read decides at once: a stale "active" may miss a revoke since (RA-1), so it
  // re-reads within the decide budget like a launch with nothing cached.
  if (accounts.load.kind === 'loading' || !isOrcaCloudAgentAccountsFresh()) {
    return 'unknown'
  }
  return cloudAgentHoldReason(agent, accounts) !== null
}

/** Hold or start, read within the decide budget when nothing is cached yet. */
export async function cloudAgentLaunchDecision(
  agent: HostAgentSignInAgent
): Promise<'hold' | 'start'> {
  const cached = cloudAgentLaunchNeedsHold(agent)
  if (cached !== 'unknown') {
    return cached ? 'hold' : 'start'
  }
  return (await holdReasonBeforeLaunch(agent)) !== null ? 'hold' : 'start'
}

// While the first read after app start is still loading, wait for it past the decide budget (up to
// this cap) rather than start an agent that isn't set up into its own /login (PC-3b).
const LOADING_CAP_MS = 15_000

async function holdReasonBeforeLaunch(
  agent: HostAgentSignInAgent
): Promise<CloudAgentHoldReason | null> {
  // A failed read that leaves nothing loaded answers at once: start, rather than wait out the cap.
  const read = ensureFreshOrcaCloudAgentAccounts().catch(() => {
    const fallback = readOrcaCloudAgentAccounts()
    return fallback.load.kind === 'ready' ? fallback : null
  })
  const budget = (ms: number) => new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))
  const accounts =
    (await Promise.race([read, budget(DECIDE_BUDGET_MS)])) ??
    (readOrcaCloudAgentAccounts().load.kind === 'loading'
      ? await Promise.race([read, budget(LOADING_CAP_MS - DECIDE_BUDGET_MS)])
      : null)
  return accounts ? cloudAgentHoldReason(agent, accounts) : null
}

/**
 * Resolves 'proceed' at once unless the agent's account sign-in is expired or revoked with no
 * key to fall back to; then it holds until Renew fixes it (every held pane goes together) or the
 * person cancels.
 */
export async function holdCloudAgentLaunch({
  decided,
  restored,
  ...hold
}: HoldRequest): Promise<'proceed' | 'cancel'> {
  // The caller's read decided to hold; if it no longer does, start rather than wait on a strip.
  const read = decided
    ? cloudAgentHoldReason(hold.agent, readOrcaCloudAgentAccounts())
    : await holdReasonBeforeLaunch(hold.agent)
  const reason = read ?? (restored ? 'awaitingStart' : null)
  if (!reason) {
    return 'proceed'
  }
  const accountsRead = readOrcaCloudAgentAccounts().load.kind === 'ready'
  const awaiting =
    reason === 'awaitingStart' ? (accountsRead ? ('covered' as const) : ('unread' as const)) : null
  return new Promise((resolve) => {
    const stop = subscribeOrcaCloudAgentAccounts(() => {
      // Renewed (or a key now covers it): every pane held on recovery starts. A first-time setup
      // waits for its "Start {{agent}}" click instead (PC-3b), so it never starts unasked.
      const entry = holds.get(hold.paneKey)
      if (entry?.release !== finish || entry.reason !== 'accountExpired') {
        return
      }
      const accounts = readOrcaCloudAgentAccounts()
      const now = accounts.load.kind === 'ready' ? cloudAgentHoldReason(hold.agent, accounts) : null
      if (accounts.load.kind !== 'ready' || now === 'accountExpired') {
        return
      }
      if (now === 'notSetUp') {
        // The sign-in was removed, not renewed: nothing covers the agent, so it never starts here;
        // the hold becomes the one-time setup.
        holds.set(hold.paneKey, { ...entry, reason: 'notSetUp' })
        notify()
        return
      }
      if (restored) {
        // After a restart the person starts it: renewed, it waits for Start (V3-01).
        holds.set(hold.paneKey, { ...entry, reason: 'awaitingStart', awaiting: 'renewed' })
        notify()
        return
      }
      finish('proceed')
    })
    function finish(outcome: 'proceed' | 'cancel'): void {
      if (holds.get(hold.paneKey)?.release !== finish) {
        return
      }
      stop()
      holds.delete(hold.paneKey)
      notify()
      resolve(outcome)
    }
    holds.set(hold.paneKey, { ...hold, reason, ...(awaiting ? { awaiting } : {}), release: finish })
    notify()
  })
}
