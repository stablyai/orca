import { useEffect, type RefObject } from 'react'
import { useAppStore } from '@/store'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'

/** Escape dismisses the pane composer only when the pane, not a layer above it, owns the key. */
export function usePaneComposerEscapeDismissal(
  containerRef: RefObject<HTMLElement | null>,
  dismiss: () => void
): void {
  const overlayModalOpen = useAppStore((state) => state.activeModal !== 'none')
  // Why: on window so nested Radix layers' handled Escape arrives defaultPrevented; sidebar/IME Escape keeps the prompt.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented || isImeOwnedKeyboardEvent(event)) {
        return
      }
      // Why: a dialog over the pane owns Escape, even when its own handler let the event through.
      if (overlayModalOpen) {
        return
      }
      // Why: the sparse preset editor owns Escape to leave its editing mode, as in the dialog.
      if (containerRef.current?.querySelector('[data-sparse-preset-editor]')) {
        return
      }
      const target = event.target
      const insidePane = target instanceof Node && containerRef.current?.contains(target) === true
      if (!insidePane && target !== document.body) {
        return
      }
      event.preventDefault()
      dismiss()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [containerRef, dismiss, overlayModalOpen])
}
