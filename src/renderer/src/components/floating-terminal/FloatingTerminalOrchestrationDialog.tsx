import { useCallback, useEffect, useState } from 'react'
import { Check, Clipboard, Loader2, Terminal } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { PASTE_TERMINAL_TEXT_EVENT } from '@/constants/terminal'
import { ORCHESTRATION_SKILL_INSTALL_COMMAND } from '@/lib/orchestration-install-command'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'

type FloatingTerminalOrchestrationDialogProps = {
  open: boolean
  activeTabId: string | null
  onOpenChange: (open: boolean) => void
}

export function FloatingTerminalOrchestrationDialog({
  open,
  activeTabId,
  onOpenChange
}: FloatingTerminalOrchestrationDialogProps): React.JSX.Element {
  const [cliStatus, setCliStatus] = useState<CliInstallStatus | null>(null)
  const [cliLoading, setCliLoading] = useState(false)
  const [cliBusy, setCliBusy] = useState(false)
  const [skillBusy, setSkillBusy] = useState(false)

  const refreshCliStatus = useCallback(async (): Promise<void> => {
    setCliLoading(true)
    try {
      setCliStatus(await window.api.cli.getInstallStatus())
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load CLI status.')
    } finally {
      setCliLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      void refreshCliStatus()
    }
  }, [open, refreshCliStatus])

  const cliInstalled = cliStatus?.state === 'installed'
  const cliSupported = cliStatus?.supported ?? false
  const cliLabel = cliInstalled
    ? 'orca is already on PATH'
    : cliLoading
      ? 'Checking CLI status...'
      : (cliStatus?.detail ?? 'Register orca so agents can call Orca from a terminal.')

  const handleInstallCli = async (): Promise<void> => {
    setCliBusy(true)
    try {
      const next = await window.api.cli.install()
      setCliStatus(next)
      toast.success('Registered `orca` in PATH.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to register `orca` in PATH.')
    } finally {
      setCliBusy(false)
    }
  }

  const handlePasteSkillCommand = async (): Promise<void> => {
    setSkillBusy(true)
    try {
      localStorage.setItem('orca.orchestration.enabled', '1')
      await window.api.ui.writeClipboardText(ORCHESTRATION_SKILL_INSTALL_COMMAND)
      if (activeTabId) {
        window.dispatchEvent(
          new CustomEvent(PASTE_TERMINAL_TEXT_EVENT, {
            detail: {
              tabId: activeTabId,
              text: ORCHESTRATION_SKILL_INSTALL_COMMAND
            }
          })
        )
        toast.success('Pasted the skill install command. Press Enter to run it.')
      } else {
        toast.success('Copied the skill install command.')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to copy skill command.')
    } finally {
      setSkillBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-5 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Enable orchestration</DialogTitle>
          <DialogDescription>
            Add the Orca CLI, then install the agent skill in this terminal.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="rounded-md border border-border/60 bg-muted/30 p-3">
            <div className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 gap-y-2 sm:grid-cols-[1.25rem_minmax(0,1fr)_auto]">
              <div className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded bg-background text-muted-foreground">
                {cliInstalled ? <Check className="size-3.5" /> : <Terminal className="size-3.5" />}
              </div>
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium">1. Add the Orca CLI to PATH</p>
                <p className="text-xs text-muted-foreground">{cliLabel}</p>
              </div>
              <div className="col-start-2 w-fit sm:col-start-3 sm:row-start-1">
                {cliInstalled ? (
                  <Badge variant="outline" className="gap-1.5">
                    <Check className="size-3" />
                    Added
                  </Badge>
                ) : (
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => void handleInstallCli()}
                    disabled={cliLoading || cliBusy || !cliSupported}
                    className="gap-1.5"
                  >
                    {cliBusy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    Add to PATH
                  </Button>
                )}
              </div>
              <div className="col-start-2 min-w-0 space-y-1 sm:col-end-3">
                {cliStatus?.commandPath ? (
                  <code className="inline-block max-w-full overflow-x-auto whitespace-nowrap rounded bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                    {cliStatus.commandPath}
                  </code>
                ) : null}
                {cliStatus?.platform === 'darwin' && !cliInstalled ? (
                  <p className="text-[11px] text-muted-foreground">
                    macOS may ask for your password so Orca can create the shell command.
                  </p>
                ) : null}
              </div>
            </div>
          </div>

          <div className="rounded-md border border-border/60 bg-muted/30 p-3">
            <div className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 gap-y-2 sm:grid-cols-[1.25rem_minmax(0,1fr)_auto]">
              <div className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded bg-background text-muted-foreground">
                <Clipboard className="size-3.5" />
              </div>
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium">2. Install the orchestration skill</p>
                <p className="text-xs text-muted-foreground">
                  Paste this command into the terminal so agents learn the orchestration commands.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handlePasteSkillCommand()}
                disabled={skillBusy}
                className="col-start-2 w-fit gap-1.5 sm:col-start-3 sm:row-start-1"
              >
                {skillBusy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {activeTabId ? 'Paste command' : 'Copy command'}
              </Button>
              <div className="col-start-2 min-w-0 sm:col-end-3">
                <code className="inline-block max-w-full overflow-x-auto whitespace-nowrap rounded bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                  {ORCHESTRATION_SKILL_INSTALL_COMMAND}
                </code>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
