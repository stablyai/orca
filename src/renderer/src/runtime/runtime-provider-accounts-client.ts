import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState,
  GlobalSettings
} from '../../../shared/types'
import type { RateLimitState } from '../../../shared/rate-limit-types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { callRuntimeRpc, getActiveRuntimeTarget, RuntimeRpcCallError } from './runtime-rpc-client'

// Mirrors OrcaRuntime.getAccountsSnapshot() / the accounts.subscribe payload.
export type ProviderAccountsSnapshot = {
  claude: ClaudeRateLimitAccountsState
  codex: CodexRateLimitAccountsState
  rateLimits: RateLimitState | null
  // Why: a partial local load substitutes an empty state for the failed
  // provider; consumers must not treat that half as an authoritative roster.
  failedProviders?: ('claude' | 'codex')[]
}

type ProviderAccountSelection = {
  accountId: string | null
  runtime: 'host' | 'wsl'
  wslDistro?: string | null
}

type ProviderAccountsSubscriptionMessage = {
  type: 'ready' | 'snapshot' | 'end'
  snapshot?: ProviderAccountsSnapshot
}

const REMOTE_ACCOUNTS_FIRST_SNAPSHOT_TIMEOUT_MS = 15_000
// Why: the server applies a selection before it awaits provider usage
// refreshes, and those refreshes can crawl behind broken auth. Give the call
// room to finish instead of reporting failure for an applied switch.
const REMOTE_ACCOUNT_MUTATION_TIMEOUT_MS = 30_000
const pendingProviderAccountsSnapshots = new Map<string, Promise<ProviderAccountsSnapshot>>()

function getProviderAccountsOwnerKey(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): string {
  const target = getActiveRuntimeTarget(settings)
  // Why: environment ids are user-controlled strings; prefix the target kind
  // so a remote id such as “local” cannot share the desktop's pending read.
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}

export function hasRemoteProviderAccountOwner(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): boolean {
  return getActiveRuntimeTarget(settings).kind === 'environment'
}

export type ProviderAccountsWatcher = {
  close: () => void
}

export function emptyClaudeAccountsState(): ClaudeRateLimitAccountsState {
  return { accounts: [], activeAccountId: null, activeAccountIdsByRuntime: { host: null, wsl: {} } }
}

export function emptyCodexAccountsState(): CodexRateLimitAccountsState {
  return { accounts: [], activeAccountId: null, activeAccountIdsByRuntime: { host: null, wsl: {} } }
}

function providerAccountsLoadError(provider: 'Claude' | 'Codex', cause: unknown): Error {
  const message = String((cause as Error)?.message ?? cause)
  return new Error(`Could not load ${provider} accounts: ${message}`)
}

// Watches the provider-account snapshot for whichever runtime owns accounts.
// Local: one-shot reads of the desktop services (they have no push channel
// here; the pane refetches after each mutation). Remote: a live
// accounts.subscribe stream — the ready message carries the current snapshot
// synchronously and later broadcasts deliver refreshed usage. accounts.list is
// deliberately avoided: it blocks behind provider usage refreshes on the
// server and can hang for minutes behind broken auth.
export function watchProviderAccounts(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  handlers: {
    onSnapshot: (snapshot: ProviderAccountsSnapshot) => void
    onError: (error: unknown) => void
  }
): ProviderAccountsWatcher {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'local') {
    let closed = false
    void Promise.allSettled([
      window.api.claudeAccounts.list(),
      window.api.codexAccounts.list()
    ]).then(([claudeResult, codexResult]) => {
      if (closed) {
        return
      }

      const claudeError =
        claudeResult.status === 'rejected'
          ? providerAccountsLoadError('Claude', claudeResult.reason)
          : null
      const codexError =
        codexResult.status === 'rejected'
          ? providerAccountsLoadError('Codex', codexResult.reason)
          : null
      if (claudeError && codexError) {
        const errors = [claudeError, codexError]
        handlers.onError(new AggregateError(errors, errors.map((error) => error.message).join(' ')))
        return
      }

      const failedProviders: ('claude' | 'codex')[] = []
      if (claudeError) {
        failedProviders.push('claude')
      }
      if (codexError) {
        failedProviders.push('codex')
      }
      handlers.onSnapshot({
        claude:
          claudeResult.status === 'fulfilled' ? claudeResult.value : emptyClaudeAccountsState(),
        codex: codexResult.status === 'fulfilled' ? codexResult.value : emptyCodexAccountsState(),
        rateLimits: null,
        ...(failedProviders.length > 0 ? { failedProviders } : {})
      })
      // Why: publish the healthy provider first so one-shot consumers keep it,
      // but re-check closed since an onSnapshot handler may close the watcher.
      for (const error of [claudeError, codexError]) {
        if (error && !closed) {
          handlers.onError(error)
        }
      }
    })
    return {
      close: () => {
        closed = true
      }
    }
  }

  let closed = false
  let unsubscribe: (() => void) | null = null
  let receivedSnapshot = false
  // Why: a subscription that never produces a first snapshot looks identical
  // to a loading state; surface it as an error so the pane can say so.
  const firstSnapshotTimer = window.setTimeout(() => {
    if (!closed && !receivedSnapshot) {
      handlers.onError(new Error('Timed out waiting for remote provider accounts.'))
    }
  }, REMOTE_ACCOUNTS_FIRST_SNAPSHOT_TIMEOUT_MS)

  void window.api.runtimeEnvironments
    .subscribe(
      {
        selector: target.environmentId,
        method: 'accounts.subscribe',
        timeoutMs: REMOTE_ACCOUNTS_FIRST_SNAPSHOT_TIMEOUT_MS
      },
      {
        onResponse: (response) => {
          if (closed) {
            return
          }
          const typed = response as RuntimeRpcResponse<ProviderAccountsSubscriptionMessage>
          if (typed.ok === false) {
            handlers.onError(new RuntimeRpcCallError(typed))
            return
          }
          const message = typed.result
          if ((message.type === 'ready' || message.type === 'snapshot') && message.snapshot) {
            receivedSnapshot = true
            handlers.onSnapshot(message.snapshot)
          }
        },
        onError: (error) => {
          if (!closed) {
            handlers.onError(new Error(error.message))
          }
        },
        onClose: () => {
          if (!closed && !receivedSnapshot) {
            handlers.onError(new Error('Remote provider account subscription closed.'))
          }
        }
      }
    )
    .then((handle) => {
      unsubscribe = handle.unsubscribe
      if (closed) {
        unsubscribe()
      }
    })
    .catch((error: unknown) => {
      if (!closed) {
        handlers.onError(error)
      }
    })

  return {
    close: () => {
      closed = true
      window.clearTimeout(firstSnapshotTimer)
      unsubscribe?.()
    }
  }
}

// One-shot convenience over watchProviderAccounts for surfaces that only need
// the current snapshot (status-bar switcher menus).
export function fetchProviderAccountsSnapshot(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): Promise<ProviderAccountsSnapshot> {
  const ownerKey = getProviderAccountsOwnerKey(settings)
  const pending = pendingProviderAccountsSnapshots.get(ownerKey)
  if (pending) {
    return pending
  }

  const request = new Promise<ProviderAccountsSnapshot>((resolve, reject) => {
    const watcher = watchProviderAccounts(settings, {
      onSnapshot: (snapshot) => {
        watcher.close()
        resolve(snapshot)
      },
      onError: (error) => {
        watcher.close()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
  pendingProviderAccountsSnapshots.set(ownerKey, request)
  const clearPending = (): void => {
    if (pendingProviderAccountsSnapshots.get(ownerKey) === request) {
      pendingProviderAccountsSnapshots.delete(ownerKey)
    }
  }
  // Why: both status-bar switchers mount together; share their in-flight read
  // without caching the result past completion or across account owners.
  void request.then(clearPending, clearPending)
  return request
}

export async function selectClaudeProviderAccount(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  selection: ProviderAccountSelection
): Promise<ClaudeRateLimitAccountsState> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'environment') {
    return callRuntimeRpc<ClaudeRateLimitAccountsState>(
      target,
      'accounts.selectClaude',
      { accountId: selection.accountId },
      { timeoutMs: REMOTE_ACCOUNT_MUTATION_TIMEOUT_MS }
    )
  }
  return window.api.claudeAccounts.select(selection)
}

export async function selectCodexProviderAccount(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  selection: ProviderAccountSelection
): Promise<CodexRateLimitAccountsState> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'environment') {
    return callRuntimeRpc<CodexRateLimitAccountsState>(
      target,
      'accounts.selectCodex',
      { accountId: selection.accountId },
      { timeoutMs: REMOTE_ACCOUNT_MUTATION_TIMEOUT_MS }
    )
  }
  return window.api.codexAccounts.select(selection)
}

export async function removeClaudeProviderAccount(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  accountId: string
): Promise<ClaudeRateLimitAccountsState> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'environment') {
    return callRuntimeRpc<ClaudeRateLimitAccountsState>(
      target,
      'accounts.removeClaude',
      { accountId },
      { timeoutMs: REMOTE_ACCOUNT_MUTATION_TIMEOUT_MS }
    )
  }
  return window.api.claudeAccounts.remove({ accountId })
}

export async function removeCodexProviderAccount(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  accountId: string
): Promise<CodexRateLimitAccountsState> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'environment') {
    return callRuntimeRpc<CodexRateLimitAccountsState>(
      target,
      'accounts.removeCodex',
      { accountId },
      { timeoutMs: REMOTE_ACCOUNT_MUTATION_TIMEOUT_MS }
    )
  }
  return window.api.codexAccounts.remove({ accountId })
}
