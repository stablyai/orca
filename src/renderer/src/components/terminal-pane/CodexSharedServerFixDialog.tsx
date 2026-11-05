import { useEffect, useState } from 'react'
import { Check, Copy, Loader2 } from 'lucide-react'
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
import {
  CODEX_DISABLE_AUTO_START_COMMAND,
  CODEX_STOP_SHARED_SERVER_COMMAND
} from '../../../../shared/codex-shared-server-command'

type FixStepStatus = 'idle' | 'running' | 'done' | 'failed'

function useFixStep(run: () => Promise<boolean>): {
  status: FixStepStatus
  start: () => Promise<boolean>
} {
  const [status, setStatus] = useState<FixStepStatus>('idle')
  const start = async (): Promise<boolean> => {
    setStatus('running')
    const ok = await run().catch(() => false)
    setStatus(ok ? 'done' : 'failed')
    return ok
  }
  return { status, start }
}

function CommandBlock({ command }: { command: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) {
      return
    }
    const timer = setTimeout(() => setCopied(false), 1_500)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted py-1.5 pr-1.5 pl-3">
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap">
        {command}
      </code>
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={() =>
          void window.api.ui
            .writeClipboardText(command)
            .then(() => setCopied(true))
            .catch(() => {})
        }
      >
        {copied ? <Check /> : <Copy />}
        {copied
          ? translate('terminal.codexSharedServerBanner.copied', 'Copied')
          : translate('terminal.codexSharedServerBanner.copy', 'Copy')}
      </Button>
    </div>
  )
}

function FixStep({
  step,
  title,
  command,
  status,
  actionLabel,
  runningLabel,
  doneLabel,
  failedLabel,
  onAction,
  locked = false,
  note,
  warning
}: {
  step: number
  title: string
  command: string
  status: FixStepStatus
  actionLabel: string
  runningLabel: string
  doneLabel: string
  failedLabel: string
  onAction: () => void
  locked?: boolean
  note?: string
  warning?: string
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3.5">
      <div className="flex items-center gap-3">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
          {step}
        </span>
        <p className="min-w-0 flex-1 text-sm font-medium">{title}</p>
        {/* Why a fixed width: the label swaps while running, and the row must not shift. */}
        <div className="flex w-28 shrink-0 justify-end">
          {status === 'done' ? (
            <span className="flex h-6 items-center gap-1 text-xs font-medium text-status-success">
              <Check className="size-3.5" aria-hidden="true" />
              {doneLabel}
            </span>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={status === 'running' || locked}
              onClick={onAction}
            >
              {status === 'running' ? <Loader2 className="animate-spin" /> : null}
              {status === 'running' ? runningLabel : actionLabel}
            </Button>
          )}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-1 pl-8">
        {/* Why always shown: the user sees exactly what Orca runs on their behalf. */}
        <p className="flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground">
          {translate('terminal.codexSharedServerBanner.runs', 'Runs')}
          <code className="min-w-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono break-all">
            {command}
          </code>
        </p>
        {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
        {warning ? <p className="text-xs text-status-warning">{warning}</p> : null}
        {status === 'failed' ? (
          <>
            <p className="text-xs text-destructive">{failedLabel}</p>
            <CommandBlock command={command} />
          </>
        ) : null}
      </div>
    </div>
  )
}

function ConfirmStopDialog({
  open,
  onOpenChange,
  onConfirm
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {translate(
              'terminal.codexSharedServerBanner.confirmStopTitle',
              'Stop the shared server?'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'terminal.codexSharedServerBanner.confirmStopDescription',
              'This closes any open Codex sessions that share it, including ones outside Orca.'
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {translate('terminal.codexSharedServerBanner.cancel', 'Cancel')}
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm}>
            {translate('terminal.codexSharedServerBanner.stopServer', 'Stop server')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function CodexSharedServerFixDialog({
  ptyId,
  open,
  onOpenChange,
  onServerStopped
}: {
  ptyId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onServerStopped: () => void
}): React.JSX.Element {
  const turnOff = useFixStep(() => window.api.pty.disableCodexSharedServerAutoStart(ptyId))
  const stop = useFixStep(() => window.api.pty.stopCodexSharedServer(ptyId))
  const [confirmStopOpen, setConfirmStopOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'terminal.codexSharedServerBanner.dialogTitle',
              'Give each Codex tab its own server'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'terminal.codexSharedServerBanner.dialogDescription',
              'Codex sessions started directly in a terminal share one background server. Orca keeps the Codex sessions it starts separate. When sessions share a server, closing one can end the others, and agent status can be wrong.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <FixStep
            step={1}
            title={translate(
              'terminal.codexSharedServerBanner.step1Title',
              'Turn off Codex server sharing'
            )}
            command={CODEX_DISABLE_AUTO_START_COMMAND}
            status={turnOff.status}
            actionLabel={translate('terminal.codexSharedServerBanner.turnOff', 'Turn off')}
            runningLabel={translate('terminal.codexSharedServerBanner.turningOff', 'Turning off…')}
            doneLabel={translate('terminal.codexSharedServerBanner.turnedOff', 'Turned off')}
            failedLabel={translate(
              'terminal.codexSharedServerBanner.turnOffFailed',
              "Orca couldn't turn this off."
            )}
            onAction={() => void turnOff.start()}
            note={translate(
              'terminal.codexSharedServerBanner.step1Note',
              'This changes your Codex settings, so it also applies outside Orca.'
            )}
          />
          <FixStep
            step={2}
            title={translate(
              'terminal.codexSharedServerBanner.step2Title',
              'Stop the running shared server'
            )}
            command={CODEX_STOP_SHARED_SERVER_COMMAND}
            status={stop.status}
            actionLabel={translate('terminal.codexSharedServerBanner.stopServer', 'Stop server')}
            runningLabel={translate('terminal.codexSharedServerBanner.stopping', 'Stopping…')}
            doneLabel={translate('terminal.codexSharedServerBanner.stopped', 'Stopped')}
            failedLabel={translate(
              'terminal.codexSharedServerBanner.stopFailed',
              "Orca couldn't stop the server."
            )}
            onAction={() => setConfirmStopOpen(true)}
            // Why: with sharing still on, the next Codex restarts the server it just closed sessions to stop.
            locked={turnOff.status !== 'done'}
            warning={translate(
              'terminal.codexSharedServerBanner.step2Warning',
              'Closes any open Codex sessions that share the server'
            )}
          />
        </div>
        <DialogFooter className="items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {translate(
              'terminal.codexSharedServerBanner.undo',
              'To undo, run codex features enable daemon_auto_start.'
            )}
          </p>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {translate('terminal.codexSharedServerBanner.done', 'Done')}
          </Button>
        </DialogFooter>
        <ConfirmStopDialog
          open={confirmStopOpen}
          onOpenChange={setConfirmStopOpen}
          onConfirm={() => {
            setConfirmStopOpen(false)
            void stop.start().then((ok) => {
              if (ok) {
                onServerStopped()
              }
            })
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
