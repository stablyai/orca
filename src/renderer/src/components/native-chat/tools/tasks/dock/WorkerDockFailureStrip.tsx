import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import type { WorkerDockFailure } from './use-worker-dock-owner-actions'

/** Carries focus from a failure line that leaves with it to the next line of the same attempt.
 *  `park` moves focus to the dock toggle; `claim` is true only if focus has stayed exactly there
 *  since; `release` ends the handoff, for an attempt that finished with no next line. */
export type WorkerDockFailureFocusHandoff = {
  park: (toggle: HTMLElement | null | undefined) => void
  claim: () => boolean
  release: () => void
}

/** A handoff that lives as long as its owner, for the owner to pass to each line it mounts. */
export function useWorkerDockFailureFocusHandoff(): WorkerDockFailureFocusHandoff {
  const parked = useRef<{ at: HTMLElement | null; stop: () => void } | null>(null)
  const [handoff] = useState<WorkerDockFailureFocusHandoff>(() => {
    const release = () => {
      parked.current?.stop()
      parked.current = null
    }
    return {
      park: (toggle) => {
        release()
        toggle?.focus()
        // Any later focus move, even one that comes back, means the user took focus over.
        document.addEventListener('focusin', release, true)
        parked.current = {
          at: toggle ?? null,
          stop: () => document.removeEventListener('focusin', release, true)
        }
      },
      claim: () => {
        const at = parked.current?.at
        const held =
          parked.current !== null &&
          (at ? document.activeElement === at : document.activeElement === document.body)
        release()
        return held
      },
      release
    }
  })
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
  // Layout timing: the unmount cleanup runs while the line is still in the document, so it can
  // see that focus is inside and park it before the page would get it.
  useLayoutEffect(() => {
    const line = root.current
    if (line && focusHandoff?.claim()) {
      line.querySelector<HTMLElement>('button')?.focus()
    }
    return () => {
      if (focusHandoff && line?.contains(document.activeElement)) {
        focusHandoff.park(
          line.parentElement?.querySelector<HTMLElement>(
            '[data-native-chat-background-tasks] button[aria-expanded]'
          )
        )
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
