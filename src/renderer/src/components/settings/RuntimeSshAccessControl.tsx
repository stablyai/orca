import { useState } from 'react'
import { toast } from 'sonner'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { SshTarget } from '../../../../shared/ssh-types'
import type { ManagedOrcadPreloadApi } from '../../../../preload/api/managed-orcad-api'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SshTargetSelect } from './SshTargetSelect'

const DEFAULT_REMOTE_PORT = '6768'

type RuntimeSshAccessControlProps = {
  api: ManagedOrcadPreloadApi
  environment: PublicKnownRuntimeEnvironment
  targets: SshTarget[]
  onChanged: () => void
}

/** Reaches an already-paired server through an SSH tunnel instead of its network address. */
export function RuntimeSshAccessControl({
  api,
  environment,
  targets,
  onChanged
}: RuntimeSshAccessControlProps): React.JSX.Element {
  const [targetId, setTargetId] = useState('')
  const [remotePort, setRemotePort] = useState(DEFAULT_REMOTE_PORT)
  const [busy, setBusy] = useState(false)
  const linked = environment.sshAccess

  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      const requestId = createBrowserUuid()
      await (linked
        ? api.unlinkSshAccess({ selector: environment.id, requestId })
        : api.linkSshAccess({
            selector: environment.id,
            requestId,
            sshTargetId: targetId,
            remotePort: Number(remotePort)
          }))
      onChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  if (linked) {
    return (
      <div className="flex items-center gap-2 px-4 py-3">
        <div className="min-w-0 flex-1 truncate text-sm">
          {translate('auto.components.settings.managedServers.access.linked', '{{name}} via SSH', {
            name: environment.name
          })}
        </div>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => void submit()}
        >
          {translate('auto.components.settings.managedServers.access.unlink', 'Stop using SSH')}
        </Button>
      </div>
    )
  }
  const port = Number(remotePort)
  const valid = targetId !== '' && Number.isInteger(port) && port >= 1 && port <= 65_535
  return (
    <div className="flex flex-wrap items-end gap-2 px-4 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <Label>{environment.name}</Label>
        <SshTargetSelect
          targets={targets}
          value={targetId}
          onChange={setTargetId}
          placeholder={translate(
            'auto.components.settings.managedServers.access.target',
            'Reach through SSH host'
          )}
        />
      </div>
      <div className="w-24 space-y-1">
        <Label>
          {translate('auto.components.settings.managedServers.access.port', 'Server port')}
        </Label>
        <Input
          value={remotePort}
          inputMode="numeric"
          onChange={(event) => setRemotePort(event.target.value)}
        />
      </div>
      <Button type="button" disabled={busy || !valid} onClick={() => void submit()}>
        {translate('auto.components.settings.managedServers.access.link', 'Use SSH')}
      </Button>
    </div>
  )
}
