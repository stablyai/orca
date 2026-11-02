import type { PreloadApi } from '../../../../preload/api-types'
import type { RateLimitState } from '../../../../shared/rate-limit-types'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import { callRuntimeResult } from './web-runtime-calls'
import { getClientForEnvironment, requireActiveEnvironmentOrNull } from './web-runtime-session'

// Why: the paired server owns provider accounts and usage; its accounts.list /
// accounts.subscribe snapshot already carries RateLimitState, so the web bridge
// reads and streams that instead of polling locally.

const ACCOUNTS_REFRESH_TIMEOUT_MS = 30_000
const RESUBSCRIBE_DELAY_MS = 5_000

export function fetchAccountsSnapshot(refreshUsage: boolean): Promise<ProviderAccountsSnapshot> {
  return callRuntimeResult<ProviderAccountsSnapshot>(
    'accounts.list',
    { refreshUsage },
    ACCOUNTS_REFRESH_TIMEOUT_MS
  )
}

const listeners = new Set<(state: RateLimitState) => void>()
let stream: { unsubscribe: () => void } | null = null
let streamStarting = false
let resubscribeTimer: ReturnType<typeof setTimeout> | null = null
let lastState: RateLimitState | null = null

function publishRateLimits(state: RateLimitState): void {
  lastState = state
  for (const listener of listeners) {
    listener(state)
  }
}

function readSnapshotRateLimits(result: unknown): RateLimitState | null {
  if (typeof result !== 'object' || result === null || !('snapshot' in result)) {
    return null
  }
  const { snapshot } = result
  if (typeof snapshot !== 'object' || snapshot === null || !('rateLimits' in snapshot)) {
    return null
  }
  return isRateLimitState(snapshot.rateLimits) ? snapshot.rateLimits : null
}

function isRateLimitState(value: unknown): value is RateLimitState {
  return typeof value === 'object' && value !== null && 'claude' in value && 'codex' in value
}

function scheduleResubscribe(): void {
  stream = null
  if (resubscribeTimer || listeners.size === 0) {
    return
  }
  resubscribeTimer = setTimeout(() => {
    resubscribeTimer = null
    startStream()
  }, RESUBSCRIBE_DELAY_MS)
}

function startStream(): void {
  if (stream || streamStarting || listeners.size === 0) {
    return
  }
  const environment = requireActiveEnvironmentOrNull()
  if (!environment) {
    scheduleResubscribe()
    return
  }
  streamStarting = true
  let handle: { unsubscribe: () => void } | null = null
  // Why: getClientForEnvironment throws synchronously while manually disconnected;
  // starting inside the chain always resets streamStarting so a reconnect can resubscribe.
  void Promise.resolve()
    .then(() =>
      getClientForEnvironment(environment).subscribe('accounts.subscribe', null, {
        onResponse: (response) => {
          const state = response.ok ? readSnapshotRateLimits(response.result) : null
          // Why: a server whose snapshot predates usage publishes nothing, not empty bars.
          if (state) {
            publishRateLimits(state)
          }
        },
        onError: () => {
          if (stream === handle) {
            scheduleResubscribe()
          }
        },
        onClose: () => {
          if (stream === handle) {
            scheduleResubscribe()
          }
        }
      })
    )
    .then((subscription) => {
      handle = subscription
      stream = subscription
      if (listeners.size === 0) {
        stopStream()
      }
    })
    .catch(() => scheduleResubscribe())
    .finally(() => {
      streamStarting = false
    })
}

function stopStream(): void {
  if (resubscribeTimer) {
    clearTimeout(resubscribeTimer)
    resubscribeTimer = null
  }
  const current = stream
  stream = null
  current?.unsubscribe()
}

async function readRateLimits(refreshUsage: boolean): Promise<RateLimitState> {
  try {
    const snapshot = await fetchAccountsSnapshot(refreshUsage)
    if (snapshot.rateLimits) {
      publishRateLimits(snapshot.rateLimits)
      return snapshot.rateLimits
    }
  } catch {
    // Why: a slow or unreachable server must not blank bars the stream already filled.
  }
  return lastState ?? createEmptyRateLimitState()
}

let pendingRefresh: Promise<RateLimitState> | null = null

// Why shared: a forced refresh can hold a call slot until provider fetches finish on the
// server, and the Accounts pane fires several at once.
function refreshRateLimits(): Promise<RateLimitState> {
  pendingRefresh ??= readRateLimits(true).finally(() => {
    pendingRefresh = null
  })
  return pendingRefresh
}

export function createRateLimitsApi(): NonNullable<Partial<PreloadApi>['rateLimits']> {
  const refresh = refreshRateLimits
  // Why: accounts.list({refreshUsage}) also refreshes inactive accounts on the server.
  const refreshInactive = async (): Promise<void> => {
    await refresh()
  }
  return {
    get: () => readRateLimits(false),
    refresh,
    refreshCodexForTarget: refresh,
    // Why: redemption is desktop-only; report the safe no-credit outcome with the server's usage.
    consumeCodexResetCredit: async () => ({
      outcome: 'noCredit',
      state: await readRateLimits(false)
    }),
    refreshClaudeForTarget: refresh,
    // Why: the server owns its poll cadence; a web tab must not retune it.
    setPollingInterval: () => Promise.resolve(),
    fetchInactiveClaudeAccounts: refreshInactive,
    fetchInactiveCodexAccounts: refreshInactive,
    refreshMiniMax: refresh,
    refreshGrok: refresh,
    onUpdate: (callback) => {
      listeners.add(callback)
      startStream()
      return () => {
        listeners.delete(callback)
        if (listeners.size === 0) {
          stopStream()
        }
      }
    }
  }
}
