import type { CodexConfigSyncStatus } from '../../../../shared/codex-config-sync-types'

// Why: bounded so a permanently unreadable home cannot poll forever; ~5 minutes
// total is long enough to outlast an antivirus scan or backup pass.
const CODEX_CONFIG_SYNC_RETRY_MS = 30_000
const CODEX_CONFIG_SYNC_RETRY_LIMIT = 10

export function watchCodexConfigSyncStatus(
  onStatus: (status: CodexConfigSyncStatus | null) => void
): () => void {
  let cancelled = false
  let attempts = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  const poll = (): void => {
    void window.api.codexConfigSync
      .status()
      .then((status) => {
        if (cancelled) {
          return
        }
        onStatus(status)
        if (
          status.state === 'stalled' &&
          status.reason === 'managed-home-unavailable' &&
          attempts < CODEX_CONFIG_SYNC_RETRY_LIMIT
        ) {
          attempts += 1
          retryTimer = setTimeout(poll, CODEX_CONFIG_SYNC_RETRY_MS)
        }
      })
      .catch(() => {
        if (!cancelled) {
          onStatus(null)
        }
      })
  }
  poll()
  return () => {
    cancelled = true
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
    }
  }
}
