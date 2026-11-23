// @protected-copy scope=file
import { useEffect, useId, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DialogCancel, DialogError } from '@/components/ui/dialog-parts'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useTranslate } from '@/i18n/use-translate'
import {
  CODEX_DISABLE_AUTO_START_COMMAND,
  CODEX_ENABLE_AUTO_START_COMMAND,
  CODEX_STOP_SHARED_SERVER_COMMAND
} from '../../../../../../shared/agent-launch/startup/codex-shared-server-command'

type FixPhase = 'idle' | 'disabling' | 'stopping'
type FixFailure = 'disable' | 'stop' | null

function CopyCommandButton({ command }: { command: string }): React.JSX.Element {
  const t = useTranslate()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) {
      return
    }
    const timer = setTimeout(() => setCopied(false), 1_500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-sm font-medium underline underline-offset-2 outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() =>
        void window.api.ui
          .writeClipboardText(command)
          .then(() => setCopied(true))
          .catch(() => {})
      }
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied
        ? t('terminal.codexSharedServerBanner.copied', 'Copied')
        : t('terminal.codexSharedServerBanner.copyCommand', 'Copy command')}
    </button>
  )
}

function UndoPopover(): React.JSX.Element {
  const t = useTranslate()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="link-muted" size="inline">
          {t('terminal.codexSharedServerBanner.howToUndo', 'How to undo')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto max-w-[calc(100vw-2rem)]">
        <div className="p-3 text-xs">
          <p className="text-muted-foreground">
            {t('terminal.codexSharedServerBanner.undoRun', 'To turn sharing back on, run:')}
          </p>
          <code className="mt-1 block font-mono break-all select-text">
            {CODEX_ENABLE_AUTO_START_COMMAND}
          </code>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Turns off Codex server sharing, and with the box checked then stops the running shared server.
 * Disable always runs first: stopping while sharing is on would just restart the server.
 */
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
  const t = useTranslate()
  const mountedRef = useMountedRef()
  const checkboxId = useId()
  const [sharingOff, setSharingOff] = useState(false)
  const [alsoStop, setAlsoStop] = useState(false)
  const [phase, setPhase] = useState<FixPhase>('idle')
  const [failure, setFailure] = useState<FixFailure>(null)
  const [previousOpen, setPreviousOpen] = useState(open)
  const [previousPtyId, setPreviousPtyId] = useState(ptyId)
  if (open !== previousOpen || ptyId !== previousPtyId) {
    setPreviousOpen(open)
    setPreviousPtyId(ptyId)
    if (open) {
      setSharingOff(false)
      setAlsoStop(false)
      setFailure(null)
      setPhase('idle')
    }
  }
  const busy = phase !== 'idle'

  const runStop = async (): Promise<void> => {
    setPhase('stopping')
    setFailure(null)
    const ok = await window.api.pty.stopCodexSharedServer(ptyId).catch(() => false)
    if (!mountedRef.current) {
      return
    }
    setPhase('idle')
    if (!ok) {
      setFailure('stop')
      return
    }
    onServerStopped()
    onOpenChange(false)
  }

  const run = async (): Promise<void> => {
    if (sharingOff) {
      await runStop()
      return
    }
    setPhase('disabling')
    setFailure(null)
    const ok = await window.api.pty.disableCodexSharedServerAutoStart(ptyId).catch(() => false)
    if (!mountedRef.current) {
      return
    }
    if (!ok) {
      setPhase('idle')
      setFailure('disable')
      return
    }
    setSharingOff(true)
    if (alsoStop) {
      await runStop()
      return
    }
    setPhase('idle')
    onOpenChange(false)
  }

  const verb = sharingOff
    ? phase === 'stopping'
      ? t('terminal.codexSharedServerBanner.stopping', 'Stopping…')
      : t('terminal.codexSharedServerBanner.stopServer', 'Stop server')
    : phase === 'disabling'
      ? t('terminal.codexSharedServerBanner.turningOff', 'Turning off…')
      : phase === 'stopping'
        ? t('terminal.codexSharedServerBanner.stopping', 'Stopping…')
        : alsoStop
          ? t('terminal.codexSharedServerBanner.turnOffAndStop', 'Turn off and stop server')
          : t('terminal.codexSharedServerBanner.turnOffSharing', 'Turn off sharing')

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setFailure(null)
        }
        onOpenChange(next)
      }}
    >
      <DialogContent size="confirm" busy={busy} initialFocus="cancel">
        <DialogHeader>
          <DialogTitle>
            {t(
              'terminal.codexSharedServerBanner.dialogQuestion',
              'Give each Codex tab its own server?'
            )}
          </DialogTitle>
          <DialogDescription>
            {sharingOff
              ? t(
                  'terminal.codexSharedServerBanner.stopSummary',
                  'Stops the running server and closes all Codex sessions using it.'
                )
              : t(
                  'terminal.codexSharedServerBanner.dialogSummary',
                  'Turns off Codex server sharing, also outside Orca.'
                )}
          </DialogDescription>
        </DialogHeader>
        {sharingOff ? null : (
          <div className="flex items-start gap-2">
            <Checkbox
              id={checkboxId}
              className="mt-0.5"
              checked={alsoStop}
              disabled={busy}
              onCheckedChange={(checked) => setAlsoStop(checked === true)}
            />
            <Label htmlFor={checkboxId} variant="dialog">
              {t(
                'terminal.codexSharedServerBanner.alsoStop',
                'Also stop the running server (closes all Codex sessions using it, including outside Orca)'
              )}
            </Label>
          </div>
        )}
        {failure === 'disable' ? (
          <DialogError>
            {t('terminal.codexSharedServerBanner.couldNotTurnOff', 'Couldn’t turn off sharing.')}{' '}
            <CopyCommandButton command={CODEX_DISABLE_AUTO_START_COMMAND} />
          </DialogError>
        ) : failure === 'stop' ? (
          <DialogError>
            {t(
              'terminal.codexSharedServerBanner.stopFailedAfterOff',
              'Sharing is off, but the server didn’t stop.'
            )}{' '}
            <CopyCommandButton command={CODEX_STOP_SHARED_SERVER_COMMAND} />
          </DialogError>
        ) : null}
        <DialogFooter start={sharingOff ? undefined : <UndoPopover />}>
          <DialogCancel>{t('terminal.codexSharedServerBanner.cancel', 'Cancel')}</DialogCancel>
          <Button
            type="button"
            size="sm"
            variant={sharingOff || alsoStop ? 'destructive' : 'default'}
            disabled={busy}
            onClick={() => void run()}
          >
            {verb}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
