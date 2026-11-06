import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState,
  ManagedDataAccountsState
} from '../../../shared/managed-account-types'
import type { RateLimitState } from '../../../shared/rate-limit-types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { callRuntimeRpc } from './runtime-rpc-client'
import { RuntimeRpcCallError } from './runtime-rpc-result'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

// Mirrors OrcaRuntime.getAccountsSnapshot() / the accounts.subscribe payload.
export type ProviderAccountsSnapshot = {
  opencode?: ManagedDataAccountsState
  claude: ClaudeRateLimitAccountsState
  codex: CodexRateLimitAccountsState
  rateLimits: RateLimitState | null
  // Partial local failures substitute empty state; that half is not an authoritative roster.
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
// Selection applies before slow usage refreshes; allow time so broken auth does not report an already-applied switch as failed.
const REMOTE_ACCOUNT_MUTATION_TIMEOUT_MS = 30_000
const pendingProviderAccountsSnapshots = new Map<string, Promise<ProviderAccountsSnapshot>>()

export function getProviderAccountsOwnerKey(target: RuntimeClientTarget): string {
  // Prefix target kinds because user-chosen remote IDs such as local can collide with desktop pending reads.
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
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

// Local services use one-shot reads/refetch after mutations. Remote accounts.subscribe supplies immediate snapshot and later usage; avoid accounts.list, which can block minutes behind broken-auth usage refresh.
export function watchProviderAccounts(
  target: RuntimeClientTarget,
  handlers: {
    onSnapshot: (snapshot: ProviderAccountsSnapshot) => void
    onError: (error: unknown) => void
    /** Remote only: the stream ended after its first snapshot, so later usage is unverifiable. */
    onClosedAfterSnapshot?: () => void
  }
): ProviderAccountsWatcher {
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
      // Publish healthy provider before failure, then recheck closed because snapshot handlers may dispose watcher.
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
  // Missing first snapshot otherwise looks perpetually loading; surface an error.
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
          if (closed) {
            return
          }
          if (!receivedSnapshot) {
            handlers.onError(new Error('Remote provider account subscription closed.'))
          } else {
            handlers.onClosedAfterSnapshot?.()
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

// One-shot account snapshot for status-bar switcher menus.
export function fetchProviderAccountsSnapshot(
  target: RuntimeClientTarget
): Promise<ProviderAccountsSnapshot> {
  const ownerKey = getProviderAccountsOwnerKey(target)
  const pending = pendingProviderAccountsSnapshots.get(ownerKey)
  if (pending) {
    return pending
  }

  const request = new Promise<ProviderAccountsSnapshot>((resolve, reject) => {
    const watcher = watchProviderAccounts(target, {
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
  // Share simultaneous switcher reads, never completed results or different owners’ requests.
  void request.then(clearPending, clearPending)
  return request
}

export async function selectClaudeProviderAccount(
  target: RuntimeClientTarget,
  selection: ProviderAccountSelection
): Promise<ClaudeRateLimitAccountsState> {
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
  target: RuntimeClientTarget,
  selection: ProviderAccountSelection
): Promise<CodexRateLimitAccountsState> {
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
  target: RuntimeClientTarget,
  accountId: string
): Promise<ClaudeRateLimitAccountsState> {
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
  target: RuntimeClientTarget,
  accountId: string
): Promise<CodexRateLimitAccountsState> {
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
