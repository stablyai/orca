import { useEffect, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import type {
  DaemonAsyncIoHealth,
  StalledDaemonReview
} from '../../../../shared/daemon-async-io-health'

const POLL_INTERVAL_MS = 30_000

export function StalledTerminalDaemonBanner(): React.JSX.Element | null {
  const [stalled, setStalled] = useState<DaemonAsyncIoHealth | null>(null)
  const [review, setReview] = useState<Extract<StalledDaemonReview, { status: 'ready' }> | null>(
    null
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const management = window.api?.pty?.management
  const canReview =
    stalled?.recoverySupported === true &&
    !!stalled?.owner &&
    !!management?.reviewStalledDaemon &&
    !!management?.restartStalledDaemon

  const reviewRestart = async (): Promise<void> => {
    if (!stalled?.owner || busy || !canReview) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await management.reviewStalledDaemon(stalled.owner)
      if (result.status === 'ready') {
        setReview(result)
      } else {
        setError(
          translate(
            'terminal.stalledDaemonBanner.reviewChanged',
            'The terminal service changed or could not be verified. Check again before restarting.'
          )
        )
      }
    } catch {
      setError(
        translate(
          'terminal.stalledDaemonBanner.reviewFailed',
          'Could not review the affected terminals. Try again.'
        )
      )
    } finally {
      setBusy(false)
    }
  }

  const restart = async (): Promise<void> => {
    if (!review || busy) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await management.restartStalledDaemon({
        owner: review.owner,
        sessions: review.sessions
      })
      if (result.status === 'restarted') {
        setReview(null)
        setStalled(null)
      } else {
        setReview(null)
        setError(
          translate(
            'terminal.stalledDaemonBanner.restartChanged',
            'The terminal service or its terminals changed. Review the affected terminals again.'
          )
        )
      }
    } catch {
      setReview(null)
      setError(
        translate(
          'terminal.stalledDaemonBanner.restartUnknown',
          'Restart could not be confirmed. Review the affected terminals again.'
        )
      )
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const read = window.api?.pty?.management?.asyncIoHealth
    if (!read) {
      return
    }
    let disposed = false
    let inFlight = false
    const refresh = async (): Promise<void> => {
      if (disposed || inFlight || document.visibilityState === 'hidden') {
        return
      }
      inFlight = true
      try {
        const health = await read()
        if (!disposed && health.state !== 'unverifiable') {
          setStalled(health.state === 'stalled' ? health : null)
          if (health.state !== 'stalled') {
            setReview(null)
          }
        }
      } catch {
        // Loss of contact cannot prove that asynchronous work is stalled.
      } finally {
        inFlight = false
      }
    }
    const onVisible = (): void => void refresh()
    void refresh()
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    const timer = window.setInterval(onVisible, POLL_INTERVAL_MS)
    return () => {
      disposed = true
      window.clearInterval(timer)
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  if (!stalled) {
    return null
  }
  return (
    <>
      <section
        role="alert"
        className="mx-2 mb-2 shrink-0 rounded-md border border-destructive/50 bg-worktree-sidebar-accent/40 p-2.5 text-worktree-sidebar-foreground"
      >
        <div className="flex items-start gap-2">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-destructive" aria-hidden="true" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-xs font-semibold leading-snug">
              {translate(
                'terminal.stalledDaemonBanner.title',
                'Terminal service may need a restart'
              )}
            </p>
            <p className="text-xs leading-snug text-muted-foreground">
              {translate(
                'terminal.stalledDaemonBanner.body',
                'Background work on this computer is stalled. Typing and new terminals may not work. Restarting the terminal service ends its running terminals and commands.'
              )}
            </p>
            {canReview && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => void reviewRestart()}
                disabled={busy}
              >
                {translate('terminal.stalledDaemonBanner.review', 'Review restart options')}
              </Button>
            )}
            {!canReview && (
              <p className="text-xs text-muted-foreground">
                {translate(
                  'terminal.stalledDaemonBanner.recoveryUnavailable',
                  'This terminal service cannot be safely restarted from this app version.'
                )}
              </p>
            )}
            {error && (
              <p role="status" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
        </div>
      </section>
      <Dialog
        open={review !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setReview(null)
          }
        }}
      >
        <DialogContent surface="security">
          <DialogHeader>
            <DialogTitle>
              {translate(
                'terminal.stalledDaemonBanner.confirmTitle',
                'Restart affected terminal service?'
              )}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'terminal.stalledDaemonBanner.confirmBody',
                'This ends the terminals and running commands listed below. Unsaved terminal work may be lost.'
              )}
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-64 space-y-2 overflow-y-auto scrollbar-sleek text-xs">
            {review?.sessions.map((session) => (
              <li key={session.sessionId} className="break-all rounded-md border p-2">
                <p className="font-mono">
                  {session.cwd ??
                    translate(
                      'terminal.stalledDaemonBanner.unknownDirectory',
                      'Working directory unavailable'
                    )}
                </p>
                <p className="text-muted-foreground">
                  {translate('terminal.stalledDaemonBanner.terminal', 'Terminal')}{' '}
                  {session.sessionId} · {translate('terminal.stalledDaemonBanner.pid', 'PID')}{' '}
                  {session.pid ??
                    translate('terminal.stalledDaemonBanner.unknownPid', 'unavailable')}
                </p>
              </li>
            ))}
          </ul>
          {review?.sessions.length === 0 && (
            <p className="text-xs text-muted-foreground">
              {translate(
                'terminal.stalledDaemonBanner.noSessions',
                'No running terminals were reported by this service.'
              )}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>
              {translate('terminal.stalledDaemonBanner.cancel', 'Cancel')}
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void restart()}>
              {translate('terminal.stalledDaemonBanner.restart', 'Restart affected service')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
