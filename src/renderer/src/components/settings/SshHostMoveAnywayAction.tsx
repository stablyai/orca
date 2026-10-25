import { useState } from 'react'
import type { SshManagedServerStatus, SshTarget } from '../../../../shared/ssh-types'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { sshHostServerReassurance } from '@/ssh/ssh-host-server-setup-copy'
import { trackSshConnect } from '@/ssh/ssh-connect-in-flight'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { getManagedOrcadApi } from './use-managed-server-catalog'

/** Offered only for a refusal that saved state alone causes. */
export function canMoveSshHostAnyway(status: SshManagedServerStatus | undefined): boolean {
  return Boolean(
    status?.kind === 'relay' &&
    status.reason === 'refused' &&
    status.canLeaveBehind &&
    getManagedOrcadApi()
  )
}

/**
 * The way out of a move refused only by saved state: move the host now and keep what can't move on
 * this computer. Unsaved drafts stay here, and bridged terminals keep their tabs and panes.
 */
export function SshHostMoveAnywayDialog({
  target,
  status,
  open,
  onOpenChange,
  onChanged
}: {
  target: Pick<SshTarget, 'id' | 'label'>
  status: SshManagedServerStatus | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}): React.JSX.Element | null {
  const api = getManagedOrcadApi()
  const mountedRef = useMountedRef()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const setOpen = (next: boolean): void => {
    setError(null)
    onOpenChange(next)
  }
  if (!api || status?.kind !== 'relay' || status.reason !== 'refused' || !status.canLeaveBehind) {
    return null
  }
  const moveAnyway = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.allowMoveLeavingBehind({ sshTargetId: target.id })
      // Tracked so Retry and the row's Connect join this connect instead of dialing a second.
      await trackSshConnect(target.id, window.api.ssh.connect({ targetId: target.id }))
      if (mountedRef.current) {
        setOpen(false)
      }
      onChanged()
    } catch (cause) {
      if (mountedRef.current) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (mountedRef.current) {
        setBusy(false)
      }
    }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && setOpen(false)}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.settings.moveAnyway.title', 'Move this host anyway')}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2">
              <p>
                {translate(
                  'auto.components.settings.moveAnyway.description',
                  'Orca sets itself up on {{host}} without the saved items below. They stay on this computer and don’t appear on {{host}}. Unsaved edits are kept, never deleted.',
                  { host: target.label }
                )}
              </p>
              <p>{sshHostServerReassurance(target.label)}</p>
            </div>
          </DialogDescription>
        </DialogHeader>
        {status.detail ? (
          <pre className="scrollbar-sleek max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {status.detail}
          </pre>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            {translate('auto.components.settings.moveAnyway.cancel', 'Cancel')}
          </Button>
          <Button onClick={() => void moveAnyway()} disabled={busy}>
            {translate('auto.components.settings.moveAnyway.confirm', 'Move anyway')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The same way out where the refusal shows outside Settings, e.g. a disconnected terminal pane. */
export function SshHostMoveAnywayButton({
  target,
  status,
  disabled = false
}: {
  target: Pick<SshTarget, 'id' | 'label'>
  status: SshManagedServerStatus | undefined
  disabled?: boolean
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (!canMoveSshHostAnyway(status)) {
    return null
  }
  return (
    <>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {translate('auto.components.settings.moveAnyway.action', 'Move anyway…')}
      </Button>
      {/* The connect it runs publishes the new status, so nothing here refreshes. */}
      <SshHostMoveAnywayDialog
        target={target}
        status={status}
        open={open}
        onOpenChange={setOpen}
        onChanged={() => {}}
      />
    </>
  )
}
