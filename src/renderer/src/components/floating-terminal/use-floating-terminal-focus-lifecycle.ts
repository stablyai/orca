import { useEffect } from 'react'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { clearFloatingPanelReclaimIntent } from '@/lib/floating-workspace-focus-reclaim'
import { isFloatingWorkspaceTerminalInputTarget } from '@/lib/floating-workspace-terminal-actions'
import { reportFloatingFocus } from './floating-terminal-focus-reporting'
import type { FloatingTerminalPanelItems } from './use-floating-terminal-panel-items'
import type { FloatingTerminalPanelLocalState } from './use-floating-terminal-panel-local-state'

type FloatingTerminalFocusLifecycleInput = Pick<FloatingTerminalPanelItems, 'activeTerminalId'> &
  Pick<
    FloatingTerminalPanelLocalState,
    'pendingReclaimArmByFileIdRef' | 'panelRef' | 'reclaimTerminalInputOnWindowFocusRef'
  > & { open: boolean }

export function useFloatingTerminalFocusLifecycle({
  activeTerminalId,
  pendingReclaimArmByFileIdRef,
  panelRef,
  reclaimTerminalInputOnWindowFocusRef,
  open
}: FloatingTerminalFocusLifecycleInput): void {
  useEffect(() => {
    const pendingReclaimArms = pendingReclaimArmByFileIdRef.current
    if (!open) {
      reportFloatingFocus(null, true)
      clearFloatingPanelReclaimIntent()
      pendingReclaimArms.clear()
    }
    return () => {
      reportFloatingFocus(null, true)
      clearFloatingPanelReclaimIntent()
      pendingReclaimArms.clear()
    }
  }, [open, pendingReclaimArmByFileIdRef])

  useEffect(() => {
    if (!open || typeof document === 'undefined') {
      return
    }
    const handleOutsidePointerDown = (event: PointerEvent): void => {
      const panel = panelRef.current
      if (!panel || !(event.target instanceof Node) || panel.contains(event.target)) {
        return
      }
      reportFloatingFocus(null, true)
      clearFloatingPanelReclaimIntent()
      const active = document.activeElement
      if (active instanceof HTMLElement && panel.contains(active)) {
        active.blur()
      }
    }
    const handleWindowBlur = (): void => {
      const panel = panelRef.current
      const active = document.activeElement
      reclaimTerminalInputOnWindowFocusRef.current = null
      if (!panel || !(active instanceof HTMLElement) || !panel.contains(active)) {
        return
      }
      reportFloatingFocus(null, true)
      clearFloatingPanelReclaimIntent()
      if (isFloatingWorkspaceTerminalInputTarget(active)) {
        reclaimTerminalInputOnWindowFocusRef.current = {
          helper: active,
          leafId: active.closest('[data-leaf-id]')?.getAttribute('data-leaf-id') ?? null
        }
        return
      }
      active.blur()
    }
    const handleWindowFocus = (): void => {
      const reclaim = reclaimTerminalInputOnWindowFocusRef.current
      if (!reclaim) {
        return
      }
      reclaimTerminalInputOnWindowFocusRef.current = null
      const panel = panelRef.current
      const active = document.activeElement
      if (
        panel &&
        active instanceof HTMLElement &&
        panel.contains(active) &&
        isFloatingWorkspaceTerminalInputTarget(active)
      ) {
        reportFloatingFocus(active)
        return
      }
      if ((active === null || active === document.body) && activeTerminalId) {
        if (reclaim.helper.isConnected && panel?.contains(reclaim.helper)) {
          return
        }
        focusTerminalTabSurface(activeTerminalId, reclaim.leafId, {
          onlyIfFocusUnclaimed: true,
          onImeRefocusSkipped: (nextActive) => reportFloatingFocus(nextActive),
          refreshImeContext: true
        })
      }
    }
    document.addEventListener('pointerdown', handleOutsidePointerDown, true)
    window.addEventListener('blur', handleWindowBlur)
    window.addEventListener('focus', handleWindowFocus)
    return () => {
      reclaimTerminalInputOnWindowFocusRef.current = null
      document.removeEventListener('pointerdown', handleOutsidePointerDown, true)
      window.removeEventListener('blur', handleWindowBlur)
      window.removeEventListener('focus', handleWindowFocus)
    }
  }, [activeTerminalId, open, panelRef, reclaimTerminalInputOnWindowFocusRef])
}
