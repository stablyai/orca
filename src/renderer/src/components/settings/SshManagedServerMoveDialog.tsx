import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SshManagedServerMoveResult } from '../../../../shared/ssh-managed-server-move'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import {
  describeManagedServerMove,
  isSshHostMoveRunning,
  managedServerMoveErrorText,
  managedServerMoveOfferText,
  moveSshHostToManagedServer
} from '@/ssh/ssh-managed-server-move'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

type SshManagedServerMoveDialogProps = {
  open: boolean
  targetId: string
  host: string
  terminals: number | undefined
  onClose: () => void
}

/** Confirms moving a host whose live relay terminals keep it off its managed server. */
export function SshManagedServerMoveDialog({
  open,
  targetId,
  host,
  terminals,
  onClose
}: SshManagedServerMoveDialogProps): React.JSX.Element {
  const mountedRef = useMountedRef()
  // Why seeded: a remount mid-move must not offer an enabled Move for the run still in flight.
  const [running, setRunning] = useState(() => isSshHostMoveRunning(targetId))
  const [refusal, setRefusal] = useState<string | null>(null)

  const close = (): void => {
    setRefusal(null)
    onClose()
  }

  const settle = async (run: Promise<SshManagedServerMoveResult>): Promise<void> => {
    let message: string | null
    try {
      const report = describeManagedServerMove(host, await run)
      message = report.level === 'success' ? null : report.message
    } catch (error) {
      message = managedServerMoveErrorText(host, error)
    }
    if (!mountedRef.current) {
      return
    }
    setRunning(false)
    if (message) {
      setRefusal(message)
    } else {
      close()
    }
  }

  const move = (): void => {
    const run = moveSshHostToManagedServer(targetId)
    if (!run) {
      return
    }
    setRunning(true)
    setRefusal(null)
    void settle(run)
  }

  // Why: a dialog remounted mid-move reports that run's outcome instead of hanging disabled.
  useEffect(() => {
    if (isSshHostMoveRunning(targetId)) {
      const run = moveSshHostToManagedServer(targetId)
      if (run) {
        void settle(run)
      }
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- mount-only: joins a run already in flight.
  }, [])

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !running && close()}>
      <DialogContent showCloseButton={!running}>
        <DialogHeader>
          <DialogTitle>
            {translate('auto.ssh.managedServerMove.title', 'Move to managed server')}
          </DialogTitle>
          <DialogDescription>{managedServerMoveOfferText(host, terminals)}</DialogDescription>
        </DialogHeader>
        {running ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {translate(
              'auto.ssh.managedServerMove.running',
              'Moving {{host}} to a managed Orca server…',
              { host }
            )}
          </div>
        ) : null}
        {refusal ? <p className="text-sm text-destructive">{refusal}</p> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={running} onClick={close}>
            {refusal
              ? translate('auto.ssh.managedServerMove.close', 'Close')
              : translate('auto.ssh.managedServerMove.notNow', 'Not now')}
          </Button>
          <Button type="button" disabled={running} onClick={move}>
            {refusal
              ? translate('auto.ssh.managedServerMove.retry', 'Try again')
              : translate('auto.ssh.managedServerMove.confirm', 'Move')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
