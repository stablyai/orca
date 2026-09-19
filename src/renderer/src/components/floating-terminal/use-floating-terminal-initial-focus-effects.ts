import { useEffect } from 'react'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { reportFloatingFocus } from './floating-terminal-focus-reporting'
import type { FloatingTerminalPanelItems } from './use-floating-terminal-panel-items'
import type { FloatingTerminalPanelLocalState } from './use-floating-terminal-panel-local-state'

type FloatingTerminalInitialFocusInput = Pick<
  FloatingTerminalPanelItems,
  'activeTerminalId' | 'hasVisibleFloatingTabs'
> &
  Pick<FloatingTerminalPanelLocalState, 'panelRef'> & { open: boolean }

export function useFloatingTerminalInitialFocusEffects({
  activeTerminalId,
  hasVisibleFloatingTabs,
  panelRef,
  open
}: FloatingTerminalInitialFocusInput): void {
  useEffect(() => {
    if (!open || !activeTerminalId) {
      return
    }
    focusTerminalTabSurface(activeTerminalId, null, {
      onImeRefocusSkipped: (active) => reportFloatingFocus(active),
      refreshImeContext: true
    })
  }, [activeTerminalId, open])

  useEffect(() => {
    if (!open || hasVisibleFloatingTabs) {
      return
    }
    panelRef.current?.focus({ preventScroll: true })
  }, [hasVisibleFloatingTabs, open, panelRef])
}
