import { useState } from 'react'
import type { SshTarget } from '../../../../shared/ssh-types'
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
import { getManagedOrcadApi } from './use-managed-server-catalog'

/** An older build changed this host; it is offered moving those additions or keeping the server’s. */
export function hasSshHostSourceChanged(target: SshTarget): boolean {
  return Boolean(getManagedOrcadApi() && target.orcadFence?.sourceChangedAt)
}

export function SshHostKeepServerVersionDialog({
  target,
  open,
  onOpenChange,
  onChanged
}: {
  target: SshTarget
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}): React.JSX.Element | null {
  const api = getManagedOrcadApi()
  const mountedRef = useMountedRef()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const setKeeping = (next: boolean): void => {
    setError(null)
    onOpenChange(next)
  }
  if (!api || !target.orcadFence?.sourceChangedAt) {
    return null
  }
  const keepServerVersion = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.keepServerVersion({ sshTargetId: target.id })
      if (mountedRef.current) {
        setKeeping(false)
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
    <Dialog open={open} onOpenChange={(open) => !open && !busy && setKeeping(false)}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.settings.keepServer.title', 'Keep the server’s version')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.keepServer.description',
              'This host keeps using its Orca server as it is. What the older version of Orca added or changed here is not moved; it stays only in this computer’s saved settings until they are cleaned up.'
            )}
          </DialogDescription>
        </DialogHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setKeeping(false)} disabled={busy}>
            {translate('auto.components.settings.keepServer.cancel', 'Cancel')}
          </Button>
          <Button onClick={() => void keepServerVersion()} disabled={busy}>
            {translate('auto.components.settings.keepServer.confirm', 'Keep the server’s version')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
