// Orca Cloud launches decided from the Orca account, never the sandbox (agent-sign-in redesign §13).
// Ready: no hold. Expired or revoked with no key: the pane holds on the account-recovery strip
// (S4-c, card 13) until Renew in S0 fixes it for every workspace. Kill switch or a provider never
// offered: no hold here; the per-workspace sign-in (#40228's gate) runs and the strip shows it.
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

export type CloudAgentHold = {
  paneKey: string
  agent: HostAgentSignInAgent
  prompt: string | null
}

/** The hold key of a host-published tab (RA-1): its first pane shows the strip. */
export function cloudTabHoldKey(tabId: string): string {
  return `tab:${tabId}`
}

type HoldRequest = CloudAgentHold & {
  /** The caller already read the account and decided to hold; skip the re-read. */
  decided?: boolean
}

type Entry = CloudAgentHold & { release: (outcome: 'proceed' | 'cancel') => void }

const holds = new Map<string, Entry>()
const listeners = new Set<() => void>()

function notify(): void {
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

export function readCloudAgentHold(paneKey: string): CloudAgentHold | null {
  return holds.get(paneKey) ?? null
}

export function releaseCloudAgentHold(paneKey: string, outcome: 'proceed' | 'cancel'): void {
  holds.get(paneKey)?.release(outcome)
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
  return cloudAgentStripReason(agent, accounts) === 'accountExpired'
}

/** Hold or start, read within the decide budget when nothing is cached yet. */
export async function cloudAgentLaunchDecision(
  agent: HostAgentSignInAgent
): Promise<'hold' | 'start'> {
  const cached = cloudAgentLaunchNeedsHold(agent)
  if (cached !== 'unknown') {
    return cached ? 'hold' : 'start'
  }
  return (await reasonBeforeLaunch(agent)) === 'accountExpired' ? 'hold' : 'start'
}

async function reasonBeforeLaunch(
  agent: HostAgentSignInAgent
): Promise<CloudAgentStripReason | null> {
  const read = ensureFreshOrcaCloudAgentAccounts().catch(() => readOrcaCloudAgentAccounts())
  const budget = new Promise<null>((resolve) => setTimeout(() => resolve(null), DECIDE_BUDGET_MS))
  const accounts = await Promise.race([read, budget])
  return accounts ? cloudAgentStripReason(agent, accounts) : null
}

/**
 * Resolves 'proceed' at once unless the agent's account sign-in is expired or revoked with no
 * key to fall back to; then it holds until Renew fixes it (every held pane goes together) or the
 * person cancels.
 */
export async function holdCloudAgentLaunch({
  decided,
  ...hold
}: HoldRequest): Promise<'proceed' | 'cancel'> {
  if (!decided && (await reasonBeforeLaunch(hold.agent)) !== 'accountExpired') {
    return 'proceed'
  }
  return new Promise((resolve) => {
    const stop = subscribeOrcaCloudAgentAccounts(() => {
      // Renewed (or a key now covers it): every pane held on this agent starts.
      if (cloudAgentStripReason(hold.agent, readOrcaCloudAgentAccounts()) !== 'accountExpired') {
        finish('proceed')
      }
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
    holds.set(hold.paneKey, { ...hold, release: finish })
    notify()
  })
}
