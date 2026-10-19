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

/**
 * Restarts a macOS host's managed server from this connection, so its terminals get local network
 * access back (#25934). Main refuses while any terminal runs; it never ends them.
 */
export function SshHostRestartServerAction({
  status,
  onChanged
}: {
  status: SshManagedServerStatus | undefined
  onChanged: () => void
}): React.JSX.Element | null {
  const api = window.api.runtimeEnvironments.managedOrcad
  const mountedRef = useMountedRef()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!api || status?.kind !== 'managed' || !status.launchSessionEnded) {
    return null
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
        {translate('auto.components.settings.restartServer.action', 'Restart managed server…')}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !next && !busy && setOpen(false)}>
        <DialogContent showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>
              {translate('auto.components.settings.restartServer.title', 'Restart managed server')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.settings.restartServer.description',
                'Orca restarts this host’s managed server from your current connection. It restarts only when no terminals are running on the host, because terminals that are still open keep the lost access. Close them first.'
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
    </div>
  )
}

function refusalText(result: Exclude<OrcadManagedRestartResult, { outcome: 'restarted' }>): string {
  if (result.outcome === 'not-restarted') {
    return result.reason
  }
  if (result.liveSessions === null) {
    return translate(
      'auto.components.settings.restartServer.terminalsUnknown',
      'Orca couldn’t confirm whether terminals are running on this host, so it didn’t restart the managed server.'
    )
  }
  return translate(
    'auto.components.settings.restartServer.terminalsRunning',
    '{{count}} terminals are still running on this host. Close them, then restart the managed server.',
    { count: result.liveSessions }
  )
}
