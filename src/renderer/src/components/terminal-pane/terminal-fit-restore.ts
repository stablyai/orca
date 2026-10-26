import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { mapWithConcurrency } from '../../../../shared/map-with-concurrency'
import { TERMINAL_FIT_RESTORE_DEADLINE_MS } from '../../../../shared/terminal-fit-restore-deadline'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle
} from '@/runtime/runtime-terminal-stream'

type TerminalFitRestoreSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | undefined

// Mobile takeover can reclaim hundreds of PTYs; bound concurrent RPCs to avoid bursting the transport.
const RESTORE_FIT_CONCURRENCY = 8

const restoreFailedResult = (): { restored: boolean } => {
  // Why: terminal fit restore is best-effort when mobile/remote transports disappear.
  return { restored: false }
}

// Bound sleep-wedged invokes so held-fit buttons re-enable for retry (#9447).
const withRestoreFitTimeout = async (
  pending: Promise<{ restored: boolean }>,
  timeoutMs: number
): Promise<{ restored: boolean }> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<{ restored: boolean }>((resolve) => {
    timer = setTimeout(() => resolve(restoreFailedResult()), timeoutMs)
  })
  try {
    return await Promise.race([pending, timedOut])
  } finally {
    clearTimeout(timer)
  }
}

async function restoreTerminalFitToDesktopWithinDeadline(
  ptyId: string,
  settings: TerminalFitRestoreSettings,
  deadlineAt: number
): Promise<boolean> {
  const timeoutMs = Math.max(0, deadlineAt - Date.now())
  if (timeoutMs === 0) {
    return false
  }
  const remoteHandle = getRemoteRuntimeTerminalHandle(ptyId)
  const environmentId =
    getRemoteRuntimePtyEnvironmentId(ptyId) ?? settings?.activeRuntimeEnvironmentId ?? null
  const pending =
    remoteHandle && environmentId
      ? callRuntimeRpc<{ restored: boolean }>(
          { kind: 'environment', environmentId },
          'terminal.restoreFit',
          { terminal: remoteHandle },
          { timeoutMs }
        ).catch(restoreFailedResult)
      : window.api.runtime.restoreTerminalFit(ptyId).catch(restoreFailedResult)
  const result = await withRestoreFitTimeout(pending, timeoutMs)

  return result.restored
}

export function restoreTerminalFitToDesktop(
  ptyId: string,
  settings: TerminalFitRestoreSettings
): Promise<boolean> {
  return restoreTerminalFitToDesktopWithinDeadline(
    ptyId,
    settings,
    Date.now() + TERMINAL_FIT_RESTORE_DEADLINE_MS
  )
}

export async function restoreTerminalFitsToDesktop(
  ptyIds: Iterable<string>,
  settings: TerminalFitRestoreSettings
): Promise<boolean> {
  const uniquePtyIds = [...new Set(ptyIds)]
  const deadlineAt = Date.now() + TERMINAL_FIT_RESTORE_DEADLINE_MS
  const results = await mapWithConcurrency(uniquePtyIds, RESTORE_FIT_CONCURRENCY, (ptyId) =>
    restoreTerminalFitToDesktopWithinDeadline(ptyId, settings, deadlineAt)
  )
  return results.some(Boolean)
}
