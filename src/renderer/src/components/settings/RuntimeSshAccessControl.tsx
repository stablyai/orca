import { Loader2 } from 'lucide-react'
import { useId, useState } from 'react'
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
  api: Pick<ManagedOrcadPreloadApi, 'linkSshAccess' | 'unlinkSshAccess'>
  environment: PublicKnownRuntimeEnvironment
  targets: SshTarget[]
  onChanged: () => void
  /** Rendered before the submit button, e.g. a dialog's Cancel. */
  footerStart?: React.ReactNode
}

/** Reaches an already-paired server through an SSH tunnel instead of its network address. */
export function RuntimeSshAccessControl({
  api,
  environment,
  targets,
  onChanged,
  footerStart
}: RuntimeSshAccessControlProps): React.JSX.Element {
  // Why: with a single SSH host there is nothing to choose.
  const [targetId, setTargetId] = useState(targets.length === 1 ? (targets[0]?.id ?? '') : '')
  const [remotePort, setRemotePort] = useState(DEFAULT_REMOTE_PORT)
  const [busy, setBusy] = useState(false)
  const targetFieldId = useId()
  const portFieldId = useId()
  const linked = environment.sshAccess
  const pending = environment.pendingSshAccessOperation

  const run = async (call: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await call()
      onChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  if (pending) {
    // Why the saved request id: main resumes or cancels only the operation it recorded, and a
    // fresh id made an unfinished link a dead end that also blocked removing the server (#27765).
    const requestId = pending.requestId
    const retry = (): Promise<unknown> =>
      pending.operation === 'link'
        ? api.linkSshAccess({
            selector: environment.id,
            requestId,
            sshTargetId: pending.sshTargetId,
            remotePort: pending.remotePort
          })
        : api.unlinkSshAccess({ selector: environment.id, requestId })
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          {pending.operation === 'link'
            ? translate(
                'auto.components.settings.managedServers.access.pendingLink',
                'Connecting through SSH didn’t finish.'
              )
            : translate(
                'auto.components.settings.managedServers.access.pendingUnlink',
                'Stopping SSH access didn’t finish.'
              )}
        </p>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {pending.operation === 'link' ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void run(() => api.unlinkSshAccess({ selector: environment.id, requestId }))
              }
            >
              {translate('auto.components.settings.managedServers.access.cancelLink', 'Cancel')}
            </Button>
          ) : null}
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => void run(retry)}
          >
            {translate('auto.components.settings.managedServers.access.retry', 'Retry')}
          </Button>
        </div>
      </div>
    )
  }

  const submit = (): Promise<void> => {
    const requestId = createBrowserUuid()
    return run(() =>
      linked
        ? api.unlinkSshAccess({ selector: environment.id, requestId })
        : api.linkSshAccess({
            selector: environment.id,
            requestId,
            sshTargetId: targetId,
            remotePort: Number(remotePort)
          })
    )
  }

  if (linked) {
    const linkedTarget = targets.find((target) => target.id === linked.sshTargetId)
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          {translate(
            'auto.components.settings.managedServers.access.linkedRoute',
            'Reached through {{host}}, server port {{port}}.',
            {
              host: linkedTarget?.label ?? linked.sshTargetId,
              port: linked.remotePort
            }
          )}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? <Loader2 className="animate-spin" /> : null}
          {translate('auto.components.settings.managedServers.access.unlink', 'Stop using SSH')}
        </Button>
      </div>
    )
  }
  const port = Number(remotePort)
  const valid = targetId !== '' && Number.isInteger(port) && port >= 1 && port <= 65_535
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!busy && valid) {
          void submit()
        }
      }}
    >
      <div className="space-y-2">
        <Label htmlFor={targetFieldId}>
          {translate('auto.components.settings.managedServers.deploy.host', 'SSH host')}
        </Label>
        <SshTargetSelect
          id={targetFieldId}
          targets={targets}
          value={targetId}
          onChange={setTargetId}
          placeholder={translate(
            'auto.components.settings.managedServers.access.chooseHost',
            'Choose a host'
          )}
        />
      </div>
      <div className="w-32 space-y-2">
        <Label htmlFor={portFieldId}>
          {translate('auto.components.settings.managedServers.access.port', 'Server port')}
        </Label>
        <Input
          id={portFieldId}
          value={remotePort}
          inputMode="numeric"
          onChange={(event) => setRemotePort(event.target.value)}
        />
      </div>
      <div className="flex justify-end gap-2">
        {footerStart}
        <Button type="submit" size="sm" disabled={busy || !valid}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          {busy
            ? translate('auto.components.settings.managedServers.access.linking', 'Connecting…')
            : translate('auto.components.settings.managedServers.access.connect', 'Connect')}
        </Button>
      </div>
    </form>
  )
}
