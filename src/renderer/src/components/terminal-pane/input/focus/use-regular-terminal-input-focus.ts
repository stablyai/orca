import { useEffect } from 'react'
import {
  consumePageFocusLossForTerminalIme,
  isXtermHelperTextarea,
  releaseTerminalFocusForOutsidePointerDown,
  releaseTerminalFocusForWindowBlur,
  resyncTerminalFocusForWindowFocus,
  setRegularTerminalInputFocusAttribute,
  syncFocusAfterFailedReclaim,
  trackPageFocusLossForTerminalIme
} from './regular-terminal-focus-ownership'
import {
  isTextEntryElement,
  refreshTerminalImeInputContext
} from '../ime/terminal-ime-input-context-refresh'
import { runSyncWithFinally } from '@/lib/run-with-finally'

export function useRegularTerminalInputFocus({
  containerRef
}: {
  containerRef: React.RefObject<HTMLDivElement | null>
}): void {
  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    trackPageFocusLossForTerminalIme()
    let ownsRegularTerminalFocus = false
    let releasedHelperOnWindowBlur: HTMLElement | null = null
    let refreshingImeInputContext = false
    const syncFocused = (focused: boolean): void => {
      ownsRegularTerminalFocus = focused
      if (focused) {
        releasedHelperOnWindowBlur = null
      }
      setRegularTerminalInputFocusAttribute(focused)
      window.api.ui.setTerminalInputFocused?.(focused)
    }
    const onFocusIn = (event: FocusEvent): void => {
      if (!isXtermHelperTextarea(event.target)) {
        return
      }
      const target = event.target
      syncFocused(true)
      // Why: macOS keeps the input context of the field or browser page focus came from (#23864).
      const pageFocusWasLost = consumePageFocusLossForTerminalIme()
      if (
        pageFocusWasLost ||
        (isTextEntryElement(event.relatedTarget) && event.relatedTarget !== target)
      ) {
        refreshingImeInputContext = true
        runSyncWithFinally(
          () => {
            refreshTerminalImeInputContext(target, {
              onRefocusSkipped: (active) => syncFocusAfterFailedReclaim(active, syncFocused)
            })
          },
          () => {
            refreshingImeInputContext = false
          }
        )
      }
    }
    const onFocusOut = (event: FocusEvent): void => {
      if (!isXtermHelperTextarea(event.target)) {
        return
      }
      if (isXtermHelperTextarea(event.relatedTarget) || refreshingImeInputContext) {
        return
      }
      syncFocused(false)
    }
    const onPointerDown = (event: PointerEvent): void => {
      releaseTerminalFocusForOutsidePointerDown({
        container,
        activeElement: document.activeElement,
        pointerTarget: event.target,
        syncFocused
      })
    }
    const onWindowBlur = (): void => {
      releasedHelperOnWindowBlur = releaseTerminalFocusForWindowBlur({
        container,
        activeElement: document.activeElement,
        syncFocused
      })
    }
    const onWindowFocus = (): void => {
      if (
        resyncTerminalFocusForWindowFocus({
          container,
          activeElement: document.activeElement,
          syncFocused,
          releasedHelper: releasedHelperOnWindowBlur
        })
      ) {
        releasedHelperOnWindowBlur = null
      }
    }
    if (
      isXtermHelperTextarea(document.activeElement) &&
      container.contains(document.activeElement)
    ) {
      syncFocused(true)
    }
    container.addEventListener('focusin', onFocusIn)
    container.addEventListener('focusout', onFocusOut)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('focus', onWindowFocus)
    return () => {
      container.removeEventListener('focusin', onFocusIn)
      container.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', onWindowBlur)
      window.removeEventListener('focus', onWindowFocus)
      if (ownsRegularTerminalFocus) {
        syncFocused(false)
      }
    }
  }, [containerRef])
}
