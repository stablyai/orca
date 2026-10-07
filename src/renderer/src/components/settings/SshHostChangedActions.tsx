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
import { SshHostDeltaMoveDialog } from './SshHostDeltaMoveDialog'

/** The two ways out for a host an older build changed: move its additions, or keep the server's. */
export function SshHostChangedActions({
  target,
  onChanged
}: {
  target: SshTarget
  onChanged: () => void
}): React.JSX.Element | null {
  const api = window.api.runtimeEnvironments.managedOrcad
  const mountedRef = useMountedRef()
  const [moving, setMoving] = useState(false)
  const [keeping, setKeeping] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
    <div className="flex flex-wrap justify-end gap-2 px-1">
      <Button type="button" size="xs" variant="outline" onClick={() => setMoving(true)}>
        {translate('auto.components.settings.deltaMove.action', 'Move the new projects…')}
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        onClick={() => {
          setError(null)
          setKeeping(true)
        }}
      >
        {translate('auto.components.settings.keepServer.action', 'Keep the server’s version…')}
      </Button>
      <SshHostDeltaMoveDialog
        api={api}
        target={moving ? target : null}
        onClose={() => setMoving(false)}
        onFinished={onChanged}
      />
      <Dialog open={keeping} onOpenChange={(open) => !open && !busy && setKeeping(false)}>
        <DialogContent showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>
              {translate('auto.components.settings.keepServer.title', 'Keep the server’s version')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.settings.keepServer.description',
                'This host goes back to its managed server as it is. What the older version of Orca added or changed here is not moved; it stays only in this computer’s saved settings until they are cleaned up.'
              )}
            </DialogDescription>
          </DialogHeader>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setKeeping(false)} disabled={busy}>
              {translate('auto.components.settings.keepServer.cancel', 'Cancel')}
            </Button>
            <Button onClick={() => void keepServerVersion()} disabled={busy}>
              {translate(
                'auto.components.settings.keepServer.confirm',
                'Keep the server’s version'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
