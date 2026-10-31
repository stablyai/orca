import { useEffect, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { openTerminalManageSessions } from '../settings/open-terminal-manage-sessions'

const POLL_INTERVAL_MS = 60_000

/** Persistent notice while fresh terminals run in-process because the kept daemon cannot start them. */
export function DegradedTerminalDaemonBanner(): React.JSX.Element | null {
  const [degraded, setDegraded] = useState(false)

  useEffect(() => {
    const read = window.api?.pty?.management?.listSessions
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
        const result = await read()
        if (!disposed) {
          setDegraded(result.degraded === true)
        }
      } catch {
        // Keep the last answer; the next poll retries.
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

  if (!degraded) {
    return null
  }
  return (
    <section
      role="alert"
      className="mx-2 mb-2 shrink-0 rounded-md border border-destructive/50 bg-worktree-sidebar-accent/40 p-2.5 text-worktree-sidebar-foreground"
    >
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-px size-3.5 shrink-0 text-destructive" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-xs font-semibold leading-snug">
            {translate(
              'terminal.degradedDaemonBanner.title',
              'New terminals are not kept when Orca quits'
            )}
          </p>
          <p className="text-xs leading-snug text-muted-foreground">
            {translate(
              'terminal.degradedDaemonBanner.body',
              'The terminal service keeps your earlier terminals running but cannot start new ones, so new terminals run inside Orca. Orca switches back by itself once those earlier terminals are closed. Restarting the terminal service now ends them.'
            )}
          </p>
          <Button type="button" variant="outline" size="xs" onClick={openTerminalManageSessions}>
            {translate('terminal.degradedDaemonBanner.review', 'Review restart options')}
          </Button>
        </div>
      </div>
    </section>
  )
}
