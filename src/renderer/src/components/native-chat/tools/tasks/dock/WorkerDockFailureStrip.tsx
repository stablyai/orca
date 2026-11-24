import { useLayoutEffect, useRef, type RefObject } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import type { WorkerDockFailure } from './use-worker-dock-owner-actions'

/** The line under the dock for an owner action that failed, with its Retry when one applies.
 *  Mount one per failure (key it), so a line that loses its Retry is replaced, not edited. */
export function WorkerDockFailureStrip({
  failure,
  onDismiss,
  focusHandoff
}: {
  failure: WorkerDockFailure
  onDismiss: () => void
  /** Set while focus left a previous line; the next line takes it back. */
  focusHandoff?: RefObject<boolean>
}) {
  const t = useTranslate()
  const root = useRef<HTMLDivElement>(null)
  // Layout timing: the unmount cleanup runs while the line is still in the document, so it can
  // see that focus is inside and move it before the page would get it.
  useLayoutEffect(() => {
    const line = root.current
    const dockToggle = () =>
      line?.parentElement?.querySelector<HTMLElement>(
        '[data-native-chat-background-tasks] button[aria-expanded]'
      )
    if (focusHandoff?.current && line) {
      focusHandoff.current = false
      // Only while focus is still where the previous line left it.
      const parked = document.activeElement
      if (parked === document.body || parked === dockToggle()) {
        line.querySelector<HTMLElement>('button')?.focus()
      }
    }
    return () => {
      if (focusHandoff && line?.contains(document.activeElement)) {
        focusHandoff.current = true
        dockToggle()?.focus()
      }
    }
  }, [focusHandoff])
  return (
    <div ref={root} role="alert" className="px-4 py-1 text-xs text-muted-foreground">
      {failure.message}
      {failure.retry ? (
        <Button variant="ghost" size="xs" onClick={failure.retry}>
          {t('components.native-chat.workerDock.retry', 'Retry')}
        </Button>
      ) : null}
      <Button variant="ghost" size="xs" onClick={onDismiss}>
        {t('components.native-chat.workerDock.dismiss', 'Dismiss')}
      </Button>
    </div>
  )
}
