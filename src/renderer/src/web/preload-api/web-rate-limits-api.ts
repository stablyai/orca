import type { PreloadApi } from '../../../../preload/api-types'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../shared/managed-account-types'
import type { RateLimitState } from '../../../../shared/rate-limit-types'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import { callRuntimeResult } from './web-runtime-calls'
import { getClientForEnvironment, requireActiveEnvironmentOrNull } from './web-runtime-session'

// Why: a web client has no local rate-limit service — the paired server owns the
// provider accounts and their usage. Its accounts snapshot (accounts.list /
// accounts.subscribe) already carries the full RateLimitState the mobile app
// renders, so the web bridge reads and streams that instead of a local poll.
type AccountsSnapshot = {
  claude: ClaudeRateLimitAccountsState
  codex: CodexRateLimitAccountsState
  rateLimits?: RateLimitState | null
}

const ACCOUNTS_REFRESH_TIMEOUT_MS = 30_000
const RESUBSCRIBE_DELAY_MS = 5_000

export function fetchAccountsSnapshot(refreshUsage: boolean): Promise<AccountsSnapshot> {
  return callRuntimeResult<AccountsSnapshot>(
    'accounts.list',
    { refreshUsage },
    ACCOUNTS_REFRESH_TIMEOUT_MS
  )
}

const listeners = new Set<(state: RateLimitState) => void>()
let stream: { unsubscribe: () => void } | null = null
let streamStarting = false
let resubscribeTimer: ReturnType<typeof setTimeout> | null = null

export function publishRateLimits(state: RateLimitState | null | undefined): void {
  if (!state) {
    return
  }
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
  // Why: getClientForEnvironment throws synchronously for a manually
  // disconnected server; starting inside the chain turns that into a rejection
  // so streamStarting is always reset and a later reconnect can resubscribe.
  void Promise.resolve()
    .then(() =>
      getClientForEnvironment(environment).subscribe('accounts.subscribe', null, {
        onResponse: (response) => {
          if (response.ok) {
            publishRateLimits(readSnapshotRateLimits(response.result))
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
    const state = snapshot.rateLimits ?? createEmptyRateLimitState()
    publishRateLimits(state)
    return state
  } catch {
    return createEmptyRateLimitState()
  }
}

export function refreshAndPublishRateLimits(): Promise<RateLimitState> {
  return readRateLimits(true)
}

export function createRateLimitsApi(): NonNullable<Partial<PreloadApi>['rateLimits']> {
  const refresh = (): Promise<RateLimitState> => readRateLimits(true)
  return {
    get: () => readRateLimits(false),
    refresh,
    refreshCodexForTarget: refresh,
    // Why: web clients don't own local Codex auth; report the safe no-credit outcome since redemption is desktop-only.
    consumeCodexResetCredit: async () => ({
      outcome: 'noCredit',
      state: await readRateLimits(false)
    }),
    refreshClaudeForTarget: refresh,
    // Why: the server owns its poll cadence; a web tab must not retune it.
    setPollingInterval: () => Promise.resolve(),
    // Why: accounts.list({refreshUsage}) also refreshes inactive accounts on the server.
    fetchInactiveClaudeAccounts: async () => {
      await refresh()
    },
    fetchInactiveCodexAccounts: async () => {
      await refresh()
    },
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
