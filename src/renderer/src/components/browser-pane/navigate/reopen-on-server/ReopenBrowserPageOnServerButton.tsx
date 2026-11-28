import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { moveBrowserPageAcrossDevices } from '../device-move/browser-page-device-move'
import {
  browserPageMoveFailureText,
  browserPageMoveOutcomeText
} from '../device-move/browser-page-device-move-copy'

/** Deferred so a fast local round-trip never flashes a spinner. */
const REOPEN_PENDING_FEEDBACK_DELAY_MS = 200

export function reopenOnServerLabel(t: Translate = translate): string {
  return t('browser.reopenOnServer.action', 'Open on server')
}

/** Honest about what a new page cannot carry over: it is not a migration. */
export function reopenOnServerCaveat(t: Translate = translate): string {
  return t(
    'browser.reopenOnServer.caveat',
    'Opens on the server at this page’s last address. Sign-in state may differ.'
  )
}

/** Moves the page that can't load here to the server, closing this tab (unless pinned) once the new one opens. */
export function ReopenBrowserPageOnServerButton({
  browserPageId,
  environmentId,
  worktreeId,
  reopenUrl,
  className,
  variant = 'secondary',
  caveatTooltip = true
}: {
  browserPageId: string
  environmentId: string
  worktreeId: string
  reopenUrl: string | null | undefined
  className?: string
  variant?: 'default' | 'secondary'
  /** Off where the caveat already sits behind its own disclosure. */
  caveatTooltip?: boolean
}): React.JSX.Element {
  const t = useTranslate()
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
    void moveBrowserPageAcrossDevices({
      browserPageId,
      environmentId,
      worktreeId,
      destination: 'server',
      url: reopenUrl
    })
      .then((outcome) => {
        const text = browserPageMoveOutcomeText(outcome, 'server')
        if (text) {
          toast.error(text)
        }
      })
      .catch((error: unknown) => {
        console.warn('[browser-device-move] reopen on server failed:', error)
        toast.error(browserPageMoveFailureText('server'))
      })
      .finally(() => {
        clearPendingTimer()
        setShowPending(false)
        setPending(false)
      })
  }, [browserPageId, clearPendingTimer, environmentId, reopenUrl, worktreeId])

  return (
    <Button
      size="sm"
      variant={variant}
      className={className}
      disabled={pending}
      aria-busy={pending}
      title={caveatTooltip ? reopenOnServerCaveat(t) : undefined}
      onClick={reopen}
    >
      {/* Both labels share one grid cell, so the swap cannot resize the button mid-action. */}
      <span className="grid place-items-center">
        <span
          className={cn('col-start-1 row-start-1', showPending && 'invisible')}
          aria-hidden={showPending}
        >
          {reopenOnServerLabel(t)}
        </span>
        <span
          className={cn(
            'col-start-1 row-start-1 flex items-center gap-1.5',
            !showPending && 'invisible'
          )}
          aria-hidden={!showPending}
        >
          {/* Spin only while shown: the hidden copy just reserves width. */}
          <Loader2 className={cn('size-3.5', showPending && 'animate-spin')} />
          {t('browser.reopenOnServer.pending', 'Opening…')}
        </span>
      </span>
    </Button>
  )
}
