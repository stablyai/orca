import type React from 'react'
import { useAnyBrowserGuestNeedsPaint } from './browser-pane/host-guest/browser-guest-paint-retention'

// Keep hidden browser guests compositing while a phone/agent drives them; display:none silently stops screencasts.
export function TerminalWorkbenchContainer({
  isVisible,
  children
}: {
  isVisible: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const retainBrowserGuestPaint = useAnyBrowserGuestNeedsPaint(!isVisible)
  return (
    <div
      className={
        isVisible
          ? 'flex flex-1 min-w-0 min-h-0'
          : retainBrowserGuestPaint
            ? // Remove the invisible workbench from flex flow so the active page keeps full height.
              'absolute inset-0 flex opacity-0 pointer-events-none'
            : 'hidden flex-1 min-w-0 min-h-0'
      }
      // Keep hidden paintable panes outside keyboard/accessibility navigation.
      inert={!isVisible}
      aria-hidden={!isVisible}
      data-terminal-workbench-container=""
    >
      {children}
    </div>
  )
}
