import { useEffect, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { translate } from '@/i18n/i18n'

const POLL_INTERVAL_MS = 30_000

export function DaemonStartupFallbackBanner(): React.JSX.Element | null {
  const [inProcess, setInProcess] = useState(false)

  useEffect(() => {
    const read = window.api?.pty?.management?.startupFallback
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
        const state = await read()
        if (!disposed) {
          setInProcess(state.freshTerminalsInProcess)
        }
      } catch {
        // Loss of contact proves nothing about where terminals run.
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

  if (!inProcess) {
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
              'terminal.daemonStartupFallbackBanner.title',
              'Terminals will close when Orca quits'
            )}
          </p>
          <p className="text-xs leading-snug text-muted-foreground">
            {translate(
              'terminal.daemonStartupFallbackBanner.body',
              'The terminal service did not start, so terminals run inside Orca and close when it quits or updates. Finish or save their work, then quit and reopen Orca to start the terminal service again.'
            )}
          </p>
        </div>
      </div>
    </section>
  )
}
