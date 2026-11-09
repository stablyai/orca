import type {
  HostAgentSignInAgent,
  HostAgentSignInReport
} from '../../../../../shared/host-agent-sign-in-status'
import { HOST_AGENT_SIGN_IN_STATUS_RUNTIME_CAPABILITY } from '../../../../../shared/account-runtime-capabilities'
import { RECIPE_VM_REFUSAL_CODES } from '../../../../../shared/remote-runtime/recipe-vm-wake'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentSupportsCapability } from '../../rpc/compatibility/runtime-capability-proof'
import {
  selectClaudeProviderAccount,
  selectCodexProviderAccount
} from '../observations/runtime-provider-accounts-client'
import {
  addClaudeAccountOnHost,
  addCodexAccountOnHost
} from './runtime-host-account-sign-in-client'

export type HostAgentSignInView =
  | { phase: 'idle' }
  | { phase: 'checking'; report: HostAgentSignInReport | null }
  | { phase: 'ready'; report: HostAgentSignInReport }
  /** The host's Orca predates the check; show nothing rather than a guess. */
  | { phase: 'unsupported' }
  /** A suspended VM: Orca does not wake it to ask. */
  | { phase: 'asleep' }
  | { phase: 'failed'; report: HostAgentSignInReport | null }

// Why: sign-in rarely changes on its own; views re-ask only after this or an explicit recheck.
const VIEW_TTL_MS = 5 * 60_000
const CALL_TIMEOUT_MS = 30_000
const RECIPE_VM_REFUSALS: ReadonlySet<string> = new Set(RECIPE_VM_REFUSAL_CODES)

type Entry = { view: HostAgentSignInView; settledAt: number; pending: Promise<void> | null }

const IDLE: HostAgentSignInView = { phase: 'idle' }
const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

function setView(environmentId: string, view: HostAgentSignInView, settled: boolean): void {
  const entry = entries.get(environmentId)
  entries.set(environmentId, {
    view,
    settledAt: settled ? Date.now() : (entry?.settledAt ?? 0),
    pending: entry?.pending ?? null
  })
  notify()
}

function lastReport(environmentId: string): HostAgentSignInReport | null {
  const view = entries.get(environmentId)?.view
  return view && 'report' in view ? view.report : null
}

function errorCode(error: unknown): string | undefined {
  const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
  return typeof code === 'string' ? code : undefined
}

async function fetchView(environmentId: string, force: boolean): Promise<HostAgentSignInView> {
  try {
    if (
      !(await runtimeEnvironmentSupportsCapability(
        environmentId,
        HOST_AGENT_SIGN_IN_STATUS_RUNTIME_CAPABILITY
      ))
    ) {
      return { phase: 'unsupported' }
    }
    const report = await callRuntimeRpc<HostAgentSignInReport>(
      { kind: 'environment', environmentId },
      'accounts.agentSignInStatus',
      force ? { force: true } : {},
      { timeoutMs: CALL_TIMEOUT_MS }
    )
    return { phase: 'ready', report }
  } catch (error) {
    const code = errorCode(error)
    if (code && RECIPE_VM_REFUSALS.has(code)) {
      return { phase: 'asleep' }
    }
    if (code === 'method_not_found') {
      return { phase: 'unsupported' }
    }
    return { phase: 'failed', report: lastReport(environmentId) }
  }
}

export function readHostAgentSignInStatus(environmentId: string): HostAgentSignInView {
  return entries.get(environmentId)?.view ?? IDLE
}

export function subscribeHostAgentSignInStatus(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Asks the host again; concurrent callers share one request. `force` skips the host's cache. */
export function refreshHostAgentSignInStatus(
  environmentId: string,
  options: { force?: boolean } = {}
): Promise<void> {
  const running = entries.get(environmentId)?.pending
  if (running) {
    return running
  }
  setView(environmentId, { phase: 'checking', report: lastReport(environmentId) }, false)
  const pending = fetchView(environmentId, options.force === true).then((view) => {
    setView(environmentId, view, true)
    const entry = entries.get(environmentId)
    if (entry) {
      entry.pending = null
    }
  })
  const entry = entries.get(environmentId)
  if (entry) {
    entry.pending = pending
  }
  return pending
}

/** Checks once per TTL for a reachable host; callers gate on reachability so a sleeping VM is never asked. */
export function ensureHostAgentSignInStatus(environmentId: string): void {
  const entry = entries.get(environmentId)
  if (entry?.pending) {
    return
  }
  const stale =
    !entry ||
    entry.view.phase === 'idle' ||
    // A woken VM must not keep showing asleep until the TTL passes.
    entry.view.phase === 'asleep' ||
    Date.now() - entry.settledAt >= VIEW_TTL_MS
  if (stale) {
    void refreshHostAgentSignInStatus(environmentId)
  }
}

type HostAccountsState = {
  accounts: { id: string; createdAt: number; managedAuthRuntime?: 'host' | 'wsl' }[]
  activeAccountId: string | null
  activeAccountIdsByRuntime?: { host: string | null }
}

function newestUnselectedHostAccount(state: HostAccountsState): string | null {
  if ((state.activeAccountIdsByRuntime?.host ?? state.activeAccountId) !== null) {
    return null
  }
  const hostAccounts = state.accounts.filter(
    (account) => (account.managedAuthRuntime ?? 'host') === 'host'
  )
  hostAccounts.sort((a, b) => b.createdAt - a.createdAt)
  return hostAccounts[0]?.id ?? null
}

/** Runs the agent's own login on the host (tokens stay there), then makes it the host's account
 *  when none was chosen, so the next agent started there is signed in. */
export async function signInAgentOnHost(
  environmentId: string,
  agent: HostAgentSignInAgent
): Promise<void> {
  const owner = { kind: 'environment', environmentId } as const
  try {
    if (agent === 'claude') {
      const accountId = newestUnselectedHostAccount(await addClaudeAccountOnHost(owner))
      if (accountId) {
        await selectClaudeProviderAccount(owner, { accountId, runtime: 'host' })
      }
    } else {
      const accountId = newestUnselectedHostAccount(await addCodexAccountOnHost(owner))
      if (accountId) {
        await selectCodexProviderAccount(owner, { accountId, runtime: 'host' })
      }
    }
  } finally {
    await refreshHostAgentSignInStatus(environmentId, { force: true })
  }
}

export function _resetHostAgentSignInStatusForTest(): void {
  entries.clear()
  listeners.clear()
}
