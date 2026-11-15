import { useSyncExternalStore } from 'react'
import type { BrowserExtensionSidePanel } from '../../../../../shared/browser/extensions/browser-extension-side-panel-types'

const EMPTY: readonly BrowserExtensionSidePanel[] = []

let panels: readonly BrowserExtensionSidePanel[] = EMPTY
let byWorkspace = new Map<string, readonly BrowserExtensionSidePanel[]>()
const listeners = new Set<() => void>()
let stopListening: (() => void) | null = null

function setPanels(next: readonly BrowserExtensionSidePanel[]): void {
  panels = next
  const grouped = new Map<string, BrowserExtensionSidePanel[]>()
  for (const panel of next) {
    const list = grouped.get(panel.workspaceId) ?? []
    list.push(panel)
    grouped.set(panel.workspaceId, list)
  }
  byWorkspace = grouped
  for (const listener of listeners) {
    listener()
  }
}

/** One IPC listener while any workspace slot is mounted; main pushes the whole list on change. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!stopListening) {
    const bridge = window.api.browser
    stopListening = bridge?.onExtensionsSidePanelsChanged?.(setPanels) ?? (() => {})
    void bridge
      ?.extensionsSidePanels?.()
      .then((initial) => {
        if (panels === EMPTY) {
          setPanels(initial)
        }
      })
      .catch(() => {})
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      stopListening?.()
      stopListening = null
      panels = EMPTY
      byWorkspace = new Map()
    }
  }
}

export function useBrowserExtensionSidePanels(
  workspaceId: string
): readonly BrowserExtensionSidePanel[] {
  return useSyncExternalStore(subscribe, () => byWorkspace.get(workspaceId) ?? EMPTY)
}

/** The panel a workspace shows on its active page: that page's own, else the workspace-wide one. */
export function resolveVisibleBrowserExtensionSidePanel(
  workspacePanels: readonly BrowserExtensionSidePanel[],
  activePageId: string | null
): BrowserExtensionSidePanel | null {
  if (!activePageId) {
    return null
  }
  return (
    workspacePanels.find((panel) => panel.browserPageId === activePageId) ??
    workspacePanels.find(
      (panel) => panel.browserPageId === undefined && !panel.hiddenOnPageIds?.includes(activePageId)
    ) ??
    null
  )
}
