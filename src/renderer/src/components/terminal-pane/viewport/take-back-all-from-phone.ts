import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { getMobileFitOverridePtyIds } from '@/lib/pane-manager/terminal-fit/mobile-fit-overrides'
import { getAllDrivers } from '@/lib/pane-manager/mobile-driver-state'
import { refitAndRefreshAllTerminalPanes } from '@/lib/pane-manager/pane-manager-registry'
import { reclaimMobileDrivenBrowserPagesForDesktop } from '@/runtime/browser/ownership/browser-desktop-reclaim'
import { restoreTerminalFitsToDesktop } from './terminal-fit-restore'

type TakeBackSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | undefined

function getMobileOwnedTerminalPtyIds(): string[] {
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
  window.setTimeout(refitAndRefreshAllTerminalPanes, 100)
}

/** Restores every terminal the phone holds and, when asked, every browser page it drives. */
export async function takeBackAllFromPhone(
  settings: TakeBackSettings,
  { includeBrowserPages }: { includeBrowserPages: boolean }
): Promise<{ terminalsRestored: boolean; reclaimedBrowserPageIds: ReadonlySet<string> }> {
  const [terminalsRestored, reclaimedBrowserPageIds] = await Promise.all([
    restoreTerminalFitsToDesktop(getMobileOwnedTerminalPtyIds(), settings),
    includeBrowserPages
      ? reclaimMobileDrivenBrowserPagesForDesktop()
      : Promise.resolve(new Set<string>())
  ])
  if (terminalsRestored) {
    scheduleRestoredTerminalRefit()
  }
  return { terminalsRestored, reclaimedBrowserPageIds }
}
