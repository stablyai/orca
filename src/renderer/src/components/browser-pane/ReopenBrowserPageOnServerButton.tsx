import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { reopenBrowserPageOnServer } from './browser-reopen-on-server'

/** Deferred so a fast local round-trip never flashes a spinner. */
const REOPEN_PENDING_FEEDBACK_DELAY_MS = 200

export function reopenOnServerLabel(): string {
  return translate('browser.reopenOnServer.action', 'Reopen on server')
}

/** Honest about what a new page cannot carry over: it is not a migration. */
export function reopenOnServerCaveat(): string {
  return translate(
    'browser.reopenOnServer.caveat',
    'This opens a new page on the remote host at this page’s last address. Signed-in and other transient page state may differ, and a page that came from a form submission opens blank.'
  )
}

export function ReopenBrowserPageOnServerButton({
  environmentId,
  worktreeId,
  lastCommittedUrl,
  className
}: {
  environmentId: string
  worktreeId: string
  lastCommittedUrl: string | null | undefined
  className?: string
}): React.JSX.Element {
  const [pending, setPending] = useState(false)
  const [showPending, setShowPending] = useState(false)
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearPendingTimer = useCallback(() => {
    if (pendingTimerRef.current !== null) {
      clearTimeout(pendingTimerRef.current)
      pendingTimerRef.current = null
    }
  }, [])

  useEffect(() => clearPendingTimer, [clearPendingTimer])

  const reopen = useCallback(() => {
    setPending(true)
    clearPendingTimer()
    pendingTimerRef.current = setTimeout(() => {
      pendingTimerRef.current = null
      setShowPending(true)
    }, REOPEN_PENDING_FEEDBACK_DELAY_MS)
    void reopenBrowserPageOnServer({ environmentId, worktreeId, lastCommittedUrl })
      .then((created) => {
        if (!created) {
          toast.error(
            translate(
              'browser.reopenOnServer.failed',
              "Couldn't open this page on the remote host. Check the connection and try again."
            )
          )
        }
      })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        clearPendingTimer()
        setShowPending(false)
        setPending(false)
      })
  }, [clearPendingTimer, environmentId, lastCommittedUrl, worktreeId])

  return (
    <Button
      size="sm"
      variant="secondary"
      className={className}
      disabled={pending}
      aria-busy={pending}
      title={reopenOnServerCaveat()}
      onClick={reopen}
    >
      {/* Both labels share one grid cell, so the swap cannot resize the button mid-action. */}
      <span className="grid place-items-center">
        <span
          className={cn('col-start-1 row-start-1', showPending && 'invisible')}
          aria-hidden={showPending}
        >
          {reopenOnServerLabel()}
        </span>
        <span
          className={cn(
            'col-start-1 row-start-1 flex items-center gap-1.5',
            !showPending && 'invisible'
          )}
          aria-hidden={!showPending}
        >
          <Loader2 className="size-3.5 animate-spin" />
          {translate('browser.reopenOnServer.pending', 'Reopening…')}
        </span>
      </span>
    </Button>
  )
}
