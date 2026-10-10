import { useEffect, useState } from 'react'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import { CLI_INSTALL_STATUS_CHANGED_EVENT } from '@/lib/cli-install-status-events'

// Why: readiness gates the whole checklist, so a wedged IPC probe must still settle.
export const CLI_STATUS_PROBE_SETTLE_TIMEOUT_MS = 15_000

export type CliStatus = {
  cliPathRegistered: boolean
  cliInstallStatusChecked: boolean
}

/**
 * `orca` is only callable from terminals outside Orca once the command is installed
 * *and* its directory is on the persisted PATH; an unreadable PATH (`null`) stays
 * unregistered rather than counted as done.
 */
export function isCliPathRegistered(status: CliInstallStatus | null): boolean {
  return status !== null && status.state === 'installed' && status.pathConfigured === true
}

/**
 * Probes whether `orca` is registered on the user's PATH. Registration happens outside
 * this hook (Settings or the checklist action), so re-probe on return to the window and
 * on the CLI section's own status events; `ready` masks both flags so readiness never
 * reports a stale probe.
 */
export function useCliStatus(ready: boolean): CliStatus {
  const [registered, setRegistered] = useState(false)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    let stale = false
    let latestRequestId = 0
    const timeoutId = window.setTimeout(() => setChecked(true), CLI_STATUS_PROBE_SETTLE_TIMEOUT_MS)
    const refreshCliPathStatus = async (): Promise<void> => {
      const requestId = ++latestRequestId
      const status = await window.api.cli.getInstallStatus().catch(() => null)
      // Why: focus and status events can overlap probes; only the newest may land.
      if (stale || requestId !== latestRequestId) {
        return
      }
      window.clearTimeout(timeoutId)
      setRegistered(isCliPathRegistered(status))
      setChecked(true)
    }
    const reprobe = (): void => void refreshCliPathStatus()
    void refreshCliPathStatus()
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        reprobe()
      }
    }
    window.addEventListener('focus', reprobe)
    window.addEventListener(CLI_INSTALL_STATUS_CHANGED_EVENT, reprobe)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      stale = true
      window.clearTimeout(timeoutId)
      window.removeEventListener('focus', reprobe)
      window.removeEventListener(CLI_INSTALL_STATUS_CHANGED_EVENT, reprobe)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  return {
    cliPathRegistered: ready && registered,
    cliInstallStatusChecked: ready && checked
  }
}
