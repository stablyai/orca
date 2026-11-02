import { useState } from 'react'
import type { SshManagedServerStatus, SshTarget } from '../../../../shared/ssh-types'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

/**
 * The way out of a move refused only by saved state: move the host now and keep what can't move on
 * this computer. Unsaved drafts are never deleted, and live terminals still have to be closed.
 */
export function SshHostMoveAnywayAction({
  target,
  status,
  onChanged
}: {
  target: SshTarget
  status: SshManagedServerStatus | undefined
  onChanged: () => void
}): React.JSX.Element | null {
  const api = window.api.runtimeEnvironments.managedOrcad
  const mountedRef = useMountedRef()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!api || status?.kind !== 'relay' || status.reason !== 'refused' || !status.canLeaveBehind) {
    return null
  }
  const moveAnyway = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.allowMoveLeavingBehind({ sshTargetId: target.id })
      await window.api.ssh.connect({ targetId: target.id })
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
    <div className="flex flex-wrap justify-end gap-2 px-1">
      <Button
        type="button"
        size="xs"
        variant="outline"
        onClick={() => {
          setError(null)
          setOpen(true)
        }}
      >
        {translate('auto.components.settings.moveAnyway.action', 'Move anyway…')}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !next && !busy && setOpen(false)}>
        <DialogContent showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>
              {translate('auto.components.settings.moveAnyway.title', 'Move this host anyway')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.settings.moveAnyway.description',
                'Orca moves this host to its managed server without the saved items below. They stay on this computer and don’t appear on the managed server. Unsaved edits are kept, never deleted.'
              )}
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
    </div>
  )
}
