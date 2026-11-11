// RA-11: an Orca Cloud pane whose agent is already running when its Orca-account sign-in expires or
// is revoked. State 1 ("expired") shows on every such pane; one Renew (S0) clears it everywhere and
// the panes that showed it move to state 2 ("renewed": Restart, never automatic) until restarted,
// dismissed, or the agent's next turn ends cleanly on its own. Decided from the Orca account (the
// same read the build sheet uses), never from terminal output.
import { useEffect, useSyncExternalStore } from 'react'
import type { HostAgentSignInAgent } from '../../../../shared/host-agent-sign-in-status'
import type { AgentSourcesView } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { agentTurnEndedUncleanly } from '../../../../shared/agent-status/lifecycle/agent-main-agent-verdict'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { orcaCloudAgentCoverage } from './orca-cloud-agent-accounts-model'
import {
  ensureFreshOrcaCloudAgentAccounts,
  type OrcaCloudAgentAccountsState
} from './orca-cloud-agent-accounts-store'

export type CloudRunningStrip =
  | { phase: 'expired'; agent: HostAgentSignInAgent }
  | { phase: 'renewed'; agent: HostAgentSignInAgent; resumable: boolean }

/** Panes that showed state 1, and when their account came back (state 2). */
const signedOut = new Map<string, { agent: HostAgentSignInAgent; renewedAt: number | null }>()
const listeners = new Set<() => void>()
let version = 0

/** Re-render the strips: this module's or the restart attempt's memory changed. */
export function notifyCloudRunningStrips(): void {
  notify()
}

function notify(): void {
  version += 1
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Re-renders when a pane's remembered state changes (dismiss, restart). */
export function useCloudRunningSignoutVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => version
  )
}

/** Forget a pane: dismissed, restarted, or its agent went away. */
export function clearCloudRunningSignout(paneKey: string): void {
  if (signedOut.delete(paneKey)) {
    notify()
  }
}

function isAccountAgent(agent: unknown): agent is HostAgentSignInAgent {
  return agent === 'claude' || agent === 'codex'
}

/**
 * What a running Orca Cloud pane shows, or null. `entry` is the pane's agent status (the agent is
 * running); `held` is true while #315's launch hold or the per-workspace gate owns the pane.
 */
export function cloudRunningStrip(args: {
  paneKey: string
  entry:
    | (Pick<
        AgentStatusEntry,
        'agentType' | 'state' | 'turnEndedAt' | 'mainAgent' | 'interrupted'
      > & {
        providerSession?: unknown
      })
    | null
  accounts: Pick<OrcaCloudAgentAccountsState, 'load' | 'keyKinds'>
  held: boolean
  now: number
  /**
   * D13: does this pane's workspace run the agent on the person's own account? false for a shared
   * workspace or a key-sourced one, null while unread or unreadable (then no strip: fail quiet).
   */
  usesAccount: boolean | null
  /**
   * useCloudRunningSignoutVersion(): passed in so a dismiss or restart (which only changes this
   * module's memory) re-decides; the React Compiler memoizes this call on its inputs.
   */
  revision: number
}): CloudRunningStrip | null {
  const { paneKey, entry, accounts } = args
  const remembered = signedOut.get(paneKey)
  const agent = entry?.agentType
  if (args.held || !isAccountAgent(agent) || accounts.load.kind !== 'ready') {
    return null
  }
  const coverage = orcaCloudAgentCoverage(agent, accounts.load.status, accounts.keyKinds[agent])
  switch (coverage.kind) {
    case 'expired':
      if (args.usesAccount !== true) {
        return null
      }
      if (!remembered || remembered.renewedAt !== null) {
        signedOut.set(paneKey, { agent, renewedAt: null })
      }
      return { phase: 'expired', agent }
    case 'account':
    case 'key': {
      if (!remembered) {
        return null
      }
      const renewedAt = remembered.renewedAt ?? args.now
      if (remembered.renewedAt === null) {
        signedOut.set(paneKey, { agent, renewedAt })
      }
      // Recovered on its own: a turn that ended cleanly after the renewal needs no restart.
      if (
        entry &&
        entry.state === 'done' &&
        (entry.turnEndedAt ?? 0) > renewedAt &&
        !agentTurnEndedUncleanly(entry)
      ) {
        signedOut.delete(paneKey)
        return null
      }
      return { phase: 'renewed', agent, resumable: Boolean(entry?.providerSession) }
    }
    // Kill switch, never offered, not set up: nothing new on a running pane.
    case 'killSwitch':
    case 'unavailable':
    case 'notSetUp':
      return null
  }
}

let liveReaders = 0
let stopInterval: (() => void) | null = null
const LIVE_READ_MS = 60_000

function readNow(): void {
  void ensureFreshOrcaCloudAgentAccounts().catch(() => undefined)
}

/**
 * While any running Orca Cloud agent pane is mounted, keep the account read fresh: on window focus
 * and at most once a minute while the window is visible (the read itself is cached for 30 s). The
 * desktop gets no push for a revoke, so this read is how the strip learns. One timer per window.
 */
export function useCloudRunningAccountReads(active: boolean): void {
  useEffect(() => {
    if (!active) {
      return
    }
    liveReaders += 1
    if (liveReaders === 1) {
      window.addEventListener('focus', readNow)
      stopInterval = installWindowVisibilityInterval({
        run: readNow,
        intervalMs: LIVE_READ_MS,
        slowWhileUnfocused: true
      })
      readNow()
    }
    return () => {
      liveReaders -= 1
      if (liveReaders === 0) {
        window.removeEventListener('focus', readNow)
        stopInterval?.()
        stopInterval = null
      }
    }
  }, [active])
}

type SourceRead = { usesAccount: boolean | null; at: number } | 'pending'
const sourceReads = new Map<string, SourceRead>()
const SOURCE_READ_MS = 10 * 60_000

/** Pure: whether a workspace's Sources view runs the agent on the person's own account (D13). */
export function workspaceUsesAccount(view: AgentSourcesView, agent: HostAgentSignInAgent): boolean {
  if (view.sharedWorkspace === true) {
    return false
  }
  const source = view.effective?.[agent]?.source ?? view.defaults[agent] ?? null
  if (source !== null) {
    return source === 'sign-in'
  }
  // Nothing chosen: a key that covers the agent wins, otherwise the account is the source.
  return !view.coveredByKey[agent]
}

/**
 * The pane's workspace Source for the agent, read once per workspace (cached 10 min) and only while
 * `wanted` (the account just went expired). Never polled; a failed read stays null (no strip).
 */
export function useWorkspaceUsesAccount(
  runtimeEnvironmentId: string | null,
  agent: HostAgentSignInAgent | null,
  wanted: boolean,
  /** Changes on every account read; a failed Source read retries then (never on its own). */
  retryToken: number
): boolean | null {
  const key = runtimeEnvironmentId && agent ? `${runtimeEnvironmentId}:${agent}` : null
  // Through the store snapshot, never a plain map read: the React Compiler would memoize that read
  // on `key` and keep the first (unread) answer for good.
  const usesAccount = useSyncExternalStore(
    subscribe,
    () => readUsesAccount(key),
    () => null
  )
  useEffect(() => {
    if (!wanted || !key || !runtimeEnvironmentId || !agent) {
      return
    }
    const read = sourceReads.get(key)
    // A good answer holds for 10 min; a failed one (e.g. right after start, before main knows the
    // sandbox) is retried on the next account read.
    if (
      read === 'pending' ||
      (read && read.usesAccount !== null && Date.now() - read.at < SOURCE_READ_MS)
    ) {
      return
    }
    const api = window.api.orcaCloudAgents
    if (!api) {
      return
    }
    sourceReads.set(key, 'pending')
    const settle = (usesAccount: boolean | null): void => {
      sourceReads.set(key, { usesAccount, at: Date.now() })
      notify()
    }
    void api
      .workspaceSources({ runtimeEnvironmentId })
      .then((result) => settle(result.ok ? workspaceUsesAccount(result.value, agent) : null))
      .catch(() => settle(null))
  }, [wanted, key, runtimeEnvironmentId, agent, retryToken])
  return usesAccount
}

function readUsesAccount(key: string | null): boolean | null {
  const read = key ? sourceReads.get(key) : undefined
  return read && read !== 'pending' ? read.usesAccount : null
}

/** Tests only. */
export function resetCloudRunningSignoutForTest(): void {
  signedOut.clear()
  sourceReads.clear()
  notify()
}
