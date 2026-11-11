import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { mapWithConcurrency } from '../../../../../shared/map-with-concurrency'
import { TERMINAL_FIT_RESTORE_DEADLINE_MS } from '../../../../../shared/terminal/viewport/terminal-fit-restore-deadline'
import { getMobileDrivenBrowserPageIds } from '@/lib/pane-manager/browser-mobile-driver-state'
import { getAllDrivers } from '@/lib/pane-manager/mobile-driver-state'
import { getMobileFitOverridePtyIds } from '@/lib/pane-manager/mobile-fit-overrides'
import {
  reassertAllTerminalPanePtySizes,
  refitAndRefreshAllTerminalPanes
} from '@/lib/pane-manager/pane-manager-registry'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle
} from '@/runtime/hosted-terminals/identity/remote-runtime-pty-owner'

type TerminalFitRestoreSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | undefined

// Mobile takeover can reclaim hundreds of PTYs; bound concurrent RPCs to avoid bursting the transport.
const RESTORE_FIT_CONCURRENCY = 8

// Follow-up refits cover next-frame layout settle and any passive main-process resize suppression window.
const RESTORED_TERMINAL_REFIT_DELAY_MS = 100
const POST_SUPPRESSION_TERMINAL_REFIT_DELAY_MS = 550

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

async function reclaimBrowserPageToDesktopWithinDeadline(
  browserPageId: string,
  deadlineAt: number
): Promise<boolean> {
  const timeoutMs = Math.max(0, deadlineAt - Date.now())
  if (timeoutMs === 0) {
    return false
  }
  const reclaimBrowserForDesktop = window.api?.runtime?.reclaimBrowserForDesktop
  if (!reclaimBrowserForDesktop) {
    return false
  }
  const pending = reclaimBrowserForDesktop(browserPageId)
    .then(({ reclaimed }) => ({ restored: Boolean(reclaimed) }))
    .catch(restoreFailedResult)
  const result = await withRestoreFitTimeout(pending, timeoutMs)

  return result.restored
}

export function getMobileOwnedTerminalPtyIds(): string[] {
  const ptyIds = new Set(getMobileFitOverridePtyIds())
  for (const [ptyId, driver] of getAllDrivers()) {
    if (driver.kind === 'mobile') {
      ptyIds.add(ptyId)
    }
  }
  return [...ptyIds]
}

export function scheduleRestoredTerminalRefit(): void {
  requestAnimationFrame(refitAndRefreshAllTerminalPanes)
  globalThis.setTimeout(refitAndRefreshAllTerminalPanes, RESTORED_TERMINAL_REFIT_DELAY_MS)
  globalThis.setTimeout(() => {
    refitAndRefreshAllTerminalPanes()
    reassertAllTerminalPanePtySizes()
  }, POST_SUPPRESSION_TERMINAL_REFIT_DELAY_MS)
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
  if (uniquePtyIds.length === 0) {
    return false
  }
  const deadlineAt = Date.now() + TERMINAL_FIT_RESTORE_DEADLINE_MS
  const results = await mapWithConcurrency(uniquePtyIds, RESTORE_FIT_CONCURRENCY, (ptyId) =>
    restoreTerminalFitToDesktopWithinDeadline(ptyId, settings, deadlineAt)
  )
  return results.some(Boolean)
}

export async function reclaimBrowserPagesToDesktop(
  browserPageIds: Iterable<string>
): Promise<boolean> {
  const uniquePageIds = [...new Set(browserPageIds)]
  if (uniquePageIds.length === 0) {
    return false
  }
  const deadlineAt = Date.now() + TERMINAL_FIT_RESTORE_DEADLINE_MS
  const results = await mapWithConcurrency(uniquePageIds, RESTORE_FIT_CONCURRENCY, (pageId) =>
    reclaimBrowserPageToDesktopWithinDeadline(pageId, deadlineAt)
  )
  return results.some(Boolean)
}

export async function reclaimAllMobileSurfacesToDesktop(
  settings: TerminalFitRestoreSettings,
  extraBrowserPageIds: Iterable<string> = []
): Promise<{
  restored: boolean
  hadTargets: boolean
  restoredTerminals: boolean
  reclaimedBrowsers: boolean
}> {
  const terminalPtyIds = getMobileOwnedTerminalPtyIds()
  const browserPageIds = [...new Set([...getMobileDrivenBrowserPageIds(), ...extraBrowserPageIds])]
  const [restoredTerminals, reclaimedBrowsers] = await Promise.all([
    restoreTerminalFitsToDesktop(terminalPtyIds, settings),
    reclaimBrowserPagesToDesktop(browserPageIds)
  ])
  return {
    restored: restoredTerminals || reclaimedBrowsers,
    hadTargets: terminalPtyIds.length > 0 || browserPageIds.length > 0,
    restoredTerminals,
    reclaimedBrowsers
  }
}
