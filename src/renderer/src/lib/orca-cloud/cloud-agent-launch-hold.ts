// Orca Cloud launches decided from the Orca account, never the sandbox (agent-sign-in redesign §13).
// Ready: no hold. Expired or revoked with no key: the pane holds on the account-recovery strip
// (S4-c, card 13) until Renew in S0 fixes it for every workspace. Kill switch or a provider never
// offered: no hold here; the per-workspace sign-in (#40228's gate) runs and the strip shows it.
import { useSyncExternalStore } from 'react'
import type { HostAgentSignInAgent } from '../../../../shared/host-agent-sign-in-status'
import { orcaCloudAgentCoverage } from './orca-cloud-agent-accounts-model'
import {
  ensureFreshOrcaCloudAgentAccounts,
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
  if (accounts.load.kind !== 'ready') {
    return null
  }
  switch (orcaCloudAgentCoverage(agent, accounts.load.status, accounts.keyKinds[agent]).kind) {
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
  if (accounts.load.kind === 'loading') {
    return 'unknown'
  }
  // A stale read refreshes in the background; the next launch uses it.
  void ensureFreshOrcaCloudAgentAccounts().catch(() => undefined)
  return cloudAgentStripReason(agent, accounts) === 'accountExpired'
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
export async function holdCloudAgentLaunch(hold: CloudAgentHold): Promise<'proceed' | 'cancel'> {
  if ((await reasonBeforeLaunch(hold.agent)) !== 'accountExpired') {
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
