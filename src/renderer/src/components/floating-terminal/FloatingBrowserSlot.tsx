import { useCallback } from 'react'
import BrowserPane from '@/components/browser-pane/BrowserPane'
import { registerBrowserOverlaySlotViewport } from '@/components/browser-pane/browser-page-viewport'
import type { BrowserTab as BrowserTabState } from '../../../../shared/types'

// Why: BrowserPane mounts its persistent Electron <webview> into a slot viewport
// root keyed by the browser tab id. The main workspace registers that root via
// BrowserPaneOverlayLayer, but the floating panel renders BrowserPane directly
// and has no overlay layer — so without registering a root here,
// ensureBrowserPageViewport returns null, the webview is never created, and the
// page spins on "loading" forever. Mirror BrowserOverlaySlot's slot-root div so
// the guest mounts and survives tab switches (the root must not be reparented).
export function FloatingBrowserSlot({
  browserTab,
  isActive
}: {
  browserTab: BrowserTabState
  isActive: boolean
}): React.JSX.Element {
  const setSlotViewportRef = useCallback(
    (node: HTMLDivElement | null): void => {
      registerBrowserOverlaySlotViewport(browserTab.id, node)
    },
    [browserTab.id]
  )

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={setSlotViewportRef} className="absolute inset-0 flex min-h-0 flex-col" />
      <BrowserPane browserTab={browserTab} isActive={isActive} />
    </div>
  )
}
