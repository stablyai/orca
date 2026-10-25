import { useAppStore } from '../store'

// Why: launch, the hosts menu and Settings → SSH can all ask within a second; one sync covers them.
const SSH_CONFIG_SYNC_MIN_INTERVAL_MS = 10_000

let inFlight: Promise<void> | null = null
let lastStartedAt = Number.NEGATIVE_INFINITY
// An import persists hosts before they are listed; a failed listing must be retried next time.
let metadataRefreshPending = false

/** Sync ~/.ssh/config without reAdopt so deleted hosts stay deleted; passive triggers keep menus fresh without opening SSH settings. */
export function syncSshConfigTargetsPassively(): Promise<void> {
  if (inFlight) {
    return inFlight
  }
  const now = Date.now()
  if (now - lastStartedAt < SSH_CONFIG_SYNC_MIN_INTERVAL_MS) {
    return Promise.resolve()
  }
  lastStartedAt = now
  inFlight = (async () => {
    try {
      const result = await window.api.ssh.importConfig()
      const store = useAppStore.getState()
      store.recordSshRepoReadoptions(result.repoReadoptions)
      // Unchanged config is the common case; skip the extra listing and store write.
      if (result.targets.length > 0 || metadataRefreshPending) {
        metadataRefreshPending = true
        useAppStore.getState().setSshTargetsMetadata(await window.api.ssh.listTargets())
        metadataRefreshPending = false
      }
    } catch {
      // Best-effort; the explicit Import button surfaces failures.
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

export function resetSshConfigPassiveSyncForTests(): void {
  inFlight = null
  lastStartedAt = Number.NEGATIVE_INFINITY
  metadataRefreshPending = false
}
