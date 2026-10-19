import { useEffect, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { openTerminalManageSessions } from '../settings/open-terminal-manage-sessions'

const POLL_INTERVAL_MS = 30_000

export function StalledTerminalDaemonBanner(): React.JSX.Element | null {
  const [stalled, setStalled] = useState(false)

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
        if (!disposed && (health.state === 'healthy' || health.state === 'stalled')) {
          setStalled(health.state === 'stalled')
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
    <section
      role="alert"
      className="mx-2 mb-2 shrink-0 rounded-md border border-destructive/50 bg-worktree-sidebar-accent/40 p-2.5 text-worktree-sidebar-foreground"
    >
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-px size-3.5 shrink-0 text-destructive" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-xs font-semibold leading-snug">
            {translate('terminal.stalledDaemonBanner.title', 'Terminal service may need a restart')}
          </p>
          <p className="text-xs leading-snug text-muted-foreground">
            {translate(
              'terminal.stalledDaemonBanner.body',
              'Background work on this computer is stalled. Typing and new terminals may not work. Restarting the terminal service ends its running terminals and commands.'
            )}
          </p>
          <Button type="button" variant="outline" size="xs" onClick={openTerminalManageSessions}>
            {translate('terminal.stalledDaemonBanner.review', 'Review restart options')}
          </Button>
        </div>
      </div>
    </section>
  )
}
