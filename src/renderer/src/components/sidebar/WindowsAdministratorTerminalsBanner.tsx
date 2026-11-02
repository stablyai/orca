import React from 'react'
import { Loader2, ShieldAlert, ShieldCheck, X } from 'lucide-react'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { PtyManagementWindowsStandardTerminalHost } from '../../../../preload/api-types'

const DISMISSED_KEY = 'orca.windowsAdministratorTerminalsBanner.dismissed'

function readDismissed(): string | null {
  try {
    return window.sessionStorage.getItem(DISMISSED_KEY)
  } catch {
    return null
  }
}

function writeDismissed(key: string): void {
  try {
    window.sessionStorage.setItem(DISMISSED_KEY, key)
  } catch {
    // Dismissal is a convenience; the banner simply shows again.
  }
}

function sessionsLabel(count: number | null): string {
  return count === null
    ? translate('terminal.windowsAdministratorBanner.unknownCount', 'its running terminals')
    : translate('terminal.windowsAdministratorBanner.count', '{{count}} running terminals', {
        count,
        defaultValue_one: '{{count}} running terminal'
      })
}

/** Orca runs elevated but adopted a terminal service started earlier without elevation. */
export function WindowsAdministratorTerminalsBanner(): React.JSX.Element | null {
  const [host, setHost] = React.useState<PtyManagementWindowsStandardTerminalHost | null>(null)
  const [dismissed, setDismissed] = React.useState<string | null>(() => readDismissed())
  const [confirming, setConfirming] = React.useState(false)
  const [restarting, setRestarting] = React.useState(false)

  const refresh = React.useCallback(async () => {
    const read = window.api?.pty?.management?.windowsStandardTerminalHost
    if (!read) {
      return
    }
    try {
      setHost((await read()).host)
    } catch {
      // Keep the last answer; the next focus retries.
    }
  }, [])

  React.useEffect(() => {
    if (window.api?.platform?.get().platform !== 'win32') {
      return
    }
    void refresh()
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const restart = React.useCallback(async () => {
    if (!host) {
      return
    }
    setRestarting(true)
    try {
      const result = await window.api.pty.management.restartWindowsStandardTerminalHost(host.pid)
      if (result.status === 'restarted') {
        toast.success(
          translate(
            'terminal.windowsAdministratorBanner.restarted',
            'Terminal service restarted as administrator.'
          )
        )
      } else {
        toast.info(
          translate(
            'terminal.windowsAdministratorBanner.alreadyReplaced',
            'The terminal service was already replaced; nothing was stopped.'
          )
        )
      }
    } catch (error) {
      toast.error(translate('terminal.windowsAdministratorBanner.failed', 'Restart failed.'), {
        description: error instanceof Error ? error.message : undefined
      })
    } finally {
      setRestarting(false)
      setConfirming(false)
      await refresh()
    }
  }, [host, refresh])

  if (!host || dismissed === String(host.pid)) {
    return null
  }
  const dismissLabel = translate('terminal.windowsAdministratorBanner.dismiss', 'Dismiss')

  return (
    <section
      role="status"
      className="mx-2 mb-2 shrink-0 rounded-md border border-worktree-sidebar-border bg-worktree-sidebar-accent/40 p-2.5 text-worktree-sidebar-foreground"
    >
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-px size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-xs font-semibold leading-snug">
            {translate(
              'terminal.windowsAdministratorBanner.title',
              'Terminals aren’t running as administrator'
            )}
          </p>
          <p className="text-xs leading-snug text-muted-foreground">
            {translate(
              'terminal.windowsAdministratorBanner.body',
              'The terminal service started before Orca had administrator rights, so new terminals open without them until it restarts.'
            )}
          </p>
          <div className="pt-0.5">
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={restarting}
              onClick={() => setConfirming(true)}
            >
              <ShieldCheck aria-hidden="true" />
              {translate('terminal.windowsAdministratorBanner.restart', 'Restart terminals')}
            </Button>
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="-mr-1 -mt-1 shrink-0 text-muted-foreground"
              aria-label={dismissLabel}
              onClick={() => {
                const key = String(host.pid)
                writeDismissed(key)
                setDismissed(key)
              }}
            >
              <X aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {dismissLabel}
          </TooltipContent>
        </Tooltip>
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
                'terminal.windowsAdministratorBanner.confirmTitle',
                'Restart terminals as administrator?'
              )}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'terminal.windowsAdministratorBanner.confirmBody',
                'Restarting ends every process in {{sessions}}. Restored tabs open new administrator shells, and agents that support resume can be resumed afterwards. Do this when your agents are idle.',
                { sessions: sessionsLabel(host.liveSessionCount) }
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={restarting} onClick={() => setConfirming(false)}>
              {translate('terminal.windowsAdministratorBanner.cancel', 'Cancel')}
            </Button>
            <Button variant="destructive" disabled={restarting} onClick={() => void restart()}>
              {restarting ? <Loader2 className="size-4 animate-spin" /> : null}
              {translate(
                'terminal.windowsAdministratorBanner.confirm',
                'Restart and end processes'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
