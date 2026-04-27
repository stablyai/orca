import { useEffect, useState } from 'react'
import { Copy, FolderOpen, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
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

type CliSectionProps = {
  currentPlatform: string
}

const ORCA_CLI_SKILL_INSTALL_COMMAND =
  'npx skills add https://github.com/stablyai/orca --skill orca-cli'

function getRevealLabel(platform: string): string {
  if (platform === 'darwin') {
    return 'Show in Finder'
  }
  if (platform === 'win32') {
    return 'Show in Explorer'
  }
  return 'Show in File Manager'
}

function getInstallDescription(platform: string): string {
  if (platform === 'darwin') {
    return 'Register `orca` in /usr/local/bin.'
  }
  if (platform === 'linux') {
    return 'Register `orca` in ~/.local/bin.'
  }
  if (platform === 'win32') {
    return 'Register `orca` in your user PATH.'
  }
  return 'CLI registration is not yet available on this platform.'
}

export function CliSection({ currentPlatform }: CliSectionProps): React.JSX.Element {
  const [status, setStatus] = useState<CliInstallStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [busyAction, setBusyAction] = useState<'install' | 'remove' | null>(null)

  const refreshStatus = async (): Promise<void> => {
    setLoading(true)
    try {
      setStatus(await window.api.cli.getInstallStatus())
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load CLI status.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refreshStatus()
  }, [])

  const isEnabled = status?.state === 'installed'
  const isSupported = status?.supported ?? false
  const revealLabel = getRevealLabel(currentPlatform)
  const canRevealCommandPath =
    status?.commandPath != null && ['installed', 'stale', 'conflict'].includes(status.state)

  const handleInstall = async (): Promise<void> => {
    setBusyAction('install')
    try {
      const next = await window.api.cli.install()
      setStatus(next)
      setDialogOpen(false)
      toast.success('Registered `orca` in PATH.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to register `orca` in PATH.')
    } finally {
      setBusyAction(null)
    }
  }

  const handleRemove = async (): Promise<void> => {
    setBusyAction('remove')
    try {
      const next = await window.api.cli.remove()
      setStatus(next)
      setDialogOpen(false)
      toast.success('Removed `orca` from PATH.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove `orca` from PATH.')
    } finally {
      setBusyAction(null)
    }
  }

  const handleCopySkillInstallCommand = async (command: string): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(command)
      toast.success('Copied skill install command.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to copy install command.')
    }
  }

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Orca CLI</h2>
        <p className="text-xs text-muted-foreground">
          Use Orca from your terminal to open the app, manage worktrees, and interact with Orca
          terminals.
        </p>
      </div>

      <div className="space-y-3 rounded-xl border border-border/60 bg-card/50 p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label>Shell command</Label>
            <p className="text-xs text-muted-foreground">
              {loading
                ? 'Checking CLI registration…'
                : (status?.detail ?? getInstallDescription(currentPlatform))}
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
                    aria-label="Refresh CLI status"
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

        {status?.state === 'installed' && !status.pathConfigured && status.pathDirectory ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {status.pathDirectory} is not currently visible on PATH for this shell.
          </p>
        ) : null}

        {!loading && !isSupported && status?.detail ? (
          <p className="text-xs text-muted-foreground">{status.detail}</p>
        ) : null}

        <div className="flex items-center gap-2">
          {status?.commandPath ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void window.api.shell.openPath(status.commandPath as string)}
              disabled={loading || !canRevealCommandPath}
              className="gap-2"
            >
              <FolderOpen className="size-3.5" />
              {revealLabel}
            </Button>
          ) : null}
        </div>

        <div className="border-t border-border/60 pt-3">
          <div className="space-y-0.5">
            <Label>Agent skills</Label>
            <p className="text-xs text-muted-foreground">
              Install skills so agents know how to use Orca and report status.
            </p>
          </div>

          <div className="mt-3 space-y-3">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">CLI skill</p>
              <div className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border/60 bg-background/60 px-3 py-2">
                <code className="overflow-x-auto whitespace-nowrap text-[11px] text-muted-foreground">
                  {ORCA_CLI_SKILL_INSTALL_COMMAND}
                </code>
                <TooltipProvider delayDuration={250}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() =>
                          void handleCopySkillInstallCommand(ORCA_CLI_SKILL_INSTALL_COMMAND)
                        }
                        aria-label="Copy CLI skill install command"
                      >
                        <Copy className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={6}>
                      Copy
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </div>
          </div>
        </div>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {isEnabled ? 'Remove `orca` from PATH?' : 'Register `orca` in PATH?'}
            </DialogTitle>
            <DialogDescription>
              {isEnabled
                ? 'This removes the shell command symlink. Orca itself remains installed.'
                : `Orca will register ${status?.commandPath ?? '`orca`'} so the command works from your terminal.`}
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
                ? 'Removing…'
                : busyAction === 'install'
                  ? 'Registering…'
                  : isEnabled
                    ? 'Remove'
                    : 'Register'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
