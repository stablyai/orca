import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import { useWindowsTerminalCapabilities } from '@/lib/windows-terminal-capabilities'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Label } from '../ui/label'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'

type WslCliRegistrationProps = {
  currentPlatform: string
}

export function WslCliRegistration({
  currentPlatform
}: WslCliRegistrationProps): React.JSX.Element | null {
  const [status, setStatus] = useState<CliInstallStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [busyAction, setBusyAction] = useState<'install' | 'remove' | null>(null)
  const { wslAvailable } = useWindowsTerminalCapabilities(currentPlatform === 'win32')
  const showWslCli = currentPlatform === 'win32' && wslAvailable

  const refreshStatus = async (): Promise<void> => {
    setLoading(true)
    try {
      setStatus(await window.api.cli.getWslInstallStatus())
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load WSL CLI status.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (showWslCli) {
      void refreshStatus()
    }
  }, [showWslCli])

  if (!showWslCli) {
    return null
  }

  const isEnabled = status?.state === 'installed'
  const isSupported = status?.supported ?? false
  const commandName = status?.commandName ?? 'orca-ide'

  const handleInstall = async (): Promise<void> => {
    setBusyAction('install')
    try {
      const next = await window.api.cli.installWsl()
      setStatus(next)
      setDialogOpen(false)
      toast.success(`Registered \`${next.commandName}\` in WSL.`)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : `Failed to register \`${commandName}\` in WSL.`
      )
    } finally {
      setBusyAction(null)
    }
  }

  const handleRemove = async (): Promise<void> => {
    setBusyAction('remove')
    try {
      const next = await window.api.cli.removeWsl()
      setStatus(next)
      setDialogOpen(false)
      toast.success(`Removed \`${next.commandName}\` from WSL.`)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : `Failed to remove \`${commandName}\` from WSL.`
      )
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <>
      <div className="space-y-3 rounded-xl border border-border/60 bg-card/50 p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label>WSL shell command</Label>
            <p className="text-xs text-muted-foreground">
              {loading
                ? 'Checking WSL CLI registration...'
                : (status?.detail ?? 'Register `orca-ide` in ~/.local/bin inside WSL.')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <TooltipProvider delayDuration={250}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => void refreshStatus()}
                    disabled={loading || busyAction !== null}
                    aria-label="Refresh WSL CLI status"
                  >
                    <RefreshCw className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  Refresh
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <button
              role="switch"
              aria-checked={isEnabled}
              disabled={loading || !isSupported || busyAction !== null}
              onClick={() => setDialogOpen(true)}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors ${
                isEnabled ? 'bg-foreground' : 'bg-muted-foreground/30'
              } ${loading || !isSupported || busyAction !== null ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
            >
              <span
                className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                  isEnabled ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        </div>

        {status?.commandPath ? (
          <p className="text-xs text-muted-foreground">
            Command path:{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">{status.commandPath}</code>
          </p>
        ) : null}

        {status?.state === 'stale' && status.currentTarget ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Existing launcher target: <code>{status.currentTarget}</code>
          </p>
        ) : null}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {isEnabled
                ? `Remove \`${commandName}\` from WSL?`
                : `Register \`${commandName}\` in WSL?`}
            </DialogTitle>
            <DialogDescription>
              {isEnabled
                ? 'This removes the WSL shell command. Orca itself remains installed on Windows.'
                : `Orca will register ${status?.commandPath ?? commandName} so the command works from WSL terminals.`}
            </DialogDescription>
          </DialogHeader>
          {status?.commandPath ? (
            <p className="text-xs text-muted-foreground">
              Target path:{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">{status.commandPath}</code>
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={busyAction !== null}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void (isEnabled ? handleRemove() : handleInstall())}
              disabled={busyAction !== null || !isSupported}
            >
              {busyAction === 'remove'
                ? 'Removing...'
                : busyAction === 'install'
                  ? 'Registering...'
                  : isEnabled
                    ? 'Remove'
                    : 'Register'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
