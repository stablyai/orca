import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import type { WorkerDockFailure } from './use-worker-dock-owner-actions'

/** `park` records that a leaving line had focus; `claim` reads and clears that once. */
export type WorkerDockFailureFocusHandoff = { park: () => void; claim: () => boolean }

/** A handoff that lives as long as its owner, for the owner to pass to each line it mounts. */
export function useWorkerDockFailureFocusHandoff(): WorkerDockFailureFocusHandoff {
  const parked = useRef(false)
  const [handoff] = useState<WorkerDockFailureFocusHandoff>(() => ({
    park: () => {
      parked.current = true
    },
    claim: () => {
      const claimed = parked.current
      parked.current = false
      return claimed
    }
  }))
  return handoff
}

/** The line under the dock for an owner action that failed, with its Retry when one applies.
 *  Mount one per failure (key it), so a line that loses its Retry is replaced, not edited. */
export function WorkerDockFailureStrip({
  failure,
  onDismiss,
  focusHandoff
}: {
  failure: WorkerDockFailure
  onDismiss: () => void
  /** Carries focus from a line that left with it to the next line. */
  focusHandoff?: WorkerDockFailureFocusHandoff
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
    if (line && focusHandoff?.claim()) {
      // Only while focus is still where the previous line left it.
      const parked = document.activeElement
      if (parked === document.body || parked === dockToggle()) {
        line.querySelector<HTMLElement>('button')?.focus()
      }
    }
    return () => {
      if (focusHandoff && line?.contains(document.activeElement)) {
        focusHandoff.park()
        dockToggle()?.focus()
      }
    }
  }, [focusHandoff])
  return (
    <div ref={root} role="alert" className="px-4 py-1 text-xs text-muted-foreground">
      {/* Space before the buttons, so a focused button's ring clears the message. */}
      <span className="mr-1.5">{failure.message}</span>
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
