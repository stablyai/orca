import { useState } from 'react'
import type { OrcadManagedRestartResult } from '../../../../shared/orcad-managed-runtime'
import type { SshManagedServerStatus } from '../../../../shared/ssh-types'
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

/** Offered only when the launching SSH session proved ended. */
export function canRestartSshHostServer(status: SshManagedServerStatus | undefined): boolean {
  return Boolean(getManagedOrcadApi() && status?.kind === 'managed' && status.launchSessionEnded)
}

/** Restart macOS managed servers to restore local-network access (#25934); main refuses running terminals and never ends them. */
export function SshHostRestartServerDialog({
  status,
  open,
  onOpenChange,
  onChanged
}: {
  status: SshManagedServerStatus | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}): React.JSX.Element | null {
  const api = getManagedOrcadApi()
  const mountedRef = useMountedRef()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!api || status?.kind !== 'managed' || !status.launchSessionEnded) {
    return null
  }
  const setOpen = (next: boolean): void => {
    setError(null)
    onOpenChange(next)
  }
  const restart = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.restart({ selector: status.environmentId })
      if (!mountedRef.current) {
        return
      }
      if (result.outcome === 'restarted') {
        setOpen(false)
        onChanged()
      } else {
        setError(refusalText(result))
      }
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
            {translate('auto.components.settings.restartServer.title', 'Restart Orca’s server')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.restartServer.description',
              'Orca restarts its server on this host from your current connection. It restarts only when no terminals are running on the host, because terminals that are still open stay cut off. Close them first.'
            )}
          </DialogDescription>
        </DialogHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            {translate('auto.components.settings.restartServer.cancel', 'Cancel')}
          </Button>
          <Button onClick={() => void restart()} disabled={busy}>
            {translate('auto.components.settings.restartServer.confirm', 'Restart')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function refusalText(result: Exclude<OrcadManagedRestartResult, { outcome: 'restarted' }>): string {
  if (result.outcome === 'not-restarted') {
    return result.reason
  }
  if (result.liveSessions === null) {
    return translate(
      'auto.components.settings.restartServer.terminalsUnknown',
      'Orca couldn’t confirm whether terminals are running on this host, so it didn’t restart Orca’s server.'
    )
  }
  return translate(
    'auto.components.settings.restartServer.terminalsRunning',
    '{{count}} terminals are still running on this host. Close them, then restart Orca’s server.',
    { count: result.liveSessions }
  )
}
