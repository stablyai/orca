import { closeTerminalTab } from '@/components/terminal/terminal-tab-actions'
import { suppressRemoteWorkspaceSnapshotWrites } from './remote-workspace-snapshot-gate'

const retiredTabIds = new Set<string>()
const MAX_RETIRED_TAB_IDS = 256

function closeRetiredTerminalTab(tabId: string): void {
  suppressRemoteWorkspaceSnapshotWrites()
  closeTerminalTab(tabId, {
    force: true,
    reason: 'cleanup',
    captureRecentlyClosed: false,
    localPtyTeardownOwnedExternally: true,
    runtimePtyTeardownOwnedExternally: true
  })
}

/** Records a main-side archive retirement before closing the renderer mirror. */
export function retireMainAuthoritativeTerminalTab(tabId: string): void {
  if (!retiredTabIds.has(tabId)) {
    retiredTabIds.add(tabId)
    if (retiredTabIds.size > MAX_RETIRED_TAB_IDS) {
      const oldestTabId = retiredTabIds.values().next().value
      if (typeof oldestTabId === 'string') {
        retiredTabIds.delete(oldestTabId)
      }
    }
  }
  closeRetiredTerminalTab(tabId)
}

/** A queued SSH snapshot can predate the archive; reapply main retirement after hydration. */
export function reapplyMainAuthoritativeTerminalRetirements(): void {
  for (const tabId of retiredTabIds) {
    closeRetiredTerminalTab(tabId)
  }
}
