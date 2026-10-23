import React from 'react'
import { LoaderCircle, RotateCw, TriangleAlert, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import type {
  PtyManagementSeveredDaemon,
  PtyManagementSeveredDaemonRestartResult
} from '../../../../preload/api-types'

const POLL_INTERVAL_MS = 60_000
const DISMISSED_KEY = 'orca.severedTerminalDaemonBanner.dismissed'

function incarnationKey(daemon: PtyManagementSeveredDaemon): string {
  return `${daemon.bootId}:${daemon.pid}:${daemon.linuxStartTicks}`
}

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_KEY)
  } catch {
    return null
  }
}

function writeDismissed(key: string): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, key)
  } catch {
    // Dismissal is a convenience; the banner simply shows again.
  }
}

function sessionsLabel(count: number | null): string {
  return count === null
    ? translate('terminal.severedDaemonBanner.unknownCount', 'its running terminals')
    : translate('terminal.severedDaemonBanner.count', '{{count}} running terminals', { count })
}

function refusalMessage(
  result: Extract<PtyManagementSeveredDaemonRestartResult, { status: 'refused' }>
): string {
  return result.reason === 'unverifiable'
    ? translate(
        'terminal.severedDaemonBanner.unverifiable',
        'Orca could not verify the terminal service process, so nothing was stopped.'
      )
    : translate(
        'terminal.severedDaemonBanner.alreadyReplaced',
        'The terminal service was already replaced; nothing was stopped.'
      )
}

/** Persistent notice for a Linux AppImage terminal daemon kept although its files are gone. */
export function SeveredTerminalDaemonBanner(): React.JSX.Element | null {
  const [daemon, setDaemon] = React.useState<PtyManagementSeveredDaemon | null>(null)
  const [dismissed, setDismissed] = React.useState<string | null>(() => readDismissed())
  const [confirming, setConfirming] = React.useState(false)
  const [restarting, setRestarting] = React.useState(false)

  const refresh = React.useCallback(async () => {
    const read = window.api?.pty?.management?.severedDaemon
    if (!read) {
      return
    }
    try {
      setDaemon((await read()).severed)
    } catch {
      // Keep the last answer; the next poll retries.
    }
  }, [])

  React.useEffect(() => {
    if (window.api?.platform?.get().platform !== 'linux') {
      return
    }
    void refresh()
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.clearInterval(timer)
    }
  }, [refresh])

  const restart = React.useCallback(async () => {
    if (!daemon) {
      return
    }
    setRestarting(true)
    try {
      const result = await window.api.pty.management.restartSeveredDaemon({
        pid: daemon.pid,
        linuxStartTicks: daemon.linuxStartTicks,
        bootId: daemon.bootId
      })
      if (result.status === 'restarted') {
        toast.success(
          translate('terminal.severedDaemonBanner.restarted', 'Terminal service restarted.')
        )
      } else {
        toast.info(refusalMessage(result))
      }
    } catch (error) {
      toast.error(translate('terminal.severedDaemonBanner.failed', 'Restart failed.'), {
        description: error instanceof Error ? error.message : undefined
      })
    } finally {
      setRestarting(false)
      setConfirming(false)
      await refresh()
    }
  }, [daemon, refresh])

  if (!daemon || dismissed === incarnationKey(daemon)) {
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
              'terminal.severedDaemonBanner.title',
              'Terminal service is running without its program files'
            )}
          </p>
          <p className="text-xs leading-snug text-muted-foreground">
            {translate(
              'terminal.severedDaemonBanner.body',
              'The terminal service on this computer started from an AppImage that is no longer mounted. It still runs {{sessions}}, but it can crash at any moment. Until you restart it, new terminals are not kept when Orca quits.',
              { sessions: sessionsLabel(daemon.liveSessionCount) }
            )}
          </p>
          <div className="flex items-center gap-1.5 pt-0.5">
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={restarting}
              onClick={() => setConfirming(true)}
            >
              <RotateCw aria-hidden="true" />
              {translate('terminal.severedDaemonBanner.restart', 'Restart terminal daemon')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                const key = incarnationKey(daemon)
                writeDismissed(key)
                setDismissed(key)
              }}
            >
              <X aria-hidden="true" />
              {translate('terminal.severedDaemonBanner.dismiss', 'Dismiss')}
            </Button>
          </div>
        </div>
      </div>
      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open && !restarting) {
            setConfirming(false)
          }
        }}
      >
        <DialogContent className="max-w-md" showCloseButton={!restarting}>
          <DialogHeader>
            <DialogTitle>
              {translate(
                'terminal.severedDaemonBanner.confirmTitle',
                'Restart the terminal daemon?'
              )}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'terminal.severedDaemonBanner.confirmBody',
                'Restarting ends every process running in {{sessions}}. Agents that support resume can be resumed afterwards; shells and other jobs cannot and must be started again. Do this when your agents are idle.',
                { sessions: sessionsLabel(daemon.liveSessionCount) }
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={restarting} onClick={() => setConfirming(false)}>
              {translate('terminal.severedDaemonBanner.cancel', 'Cancel')}
            </Button>
            <Button variant="destructive" disabled={restarting} onClick={() => void restart()}>
              {restarting ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {translate('terminal.severedDaemonBanner.confirm', 'Restart and end processes')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
