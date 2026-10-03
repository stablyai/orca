import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { OrcadManagedPendingMigrationRow } from '../../../../shared/orcad-managed-runtime'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { SshTarget } from '../../../../shared/ssh-types'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { ManagedServerRow } from './ManagedServerRow'
import { RuntimeSshAccessControl } from './RuntimeSshAccessControl'
import { SshTargetSelect } from './SshTargetSelect'
import { migrationPhaseLabel } from './managed-server-copy'

type ManagedServersSectionProps = {
  environments: PublicKnownRuntimeEnvironment[]
  onChanged: () => void
}

export function ManagedServersSection({
  environments,
  onChanged
}: ManagedServersSectionProps): React.JSX.Element | null {
  const api = window.api.runtimeEnvironments.managedOrcad
  const mountedRef = useMountedRef()
  const [targets, setTargets] = useState<SshTarget[]>([])
  const [pending, setPending] = useState<OrcadManagedPendingMigrationRow[]>([])
  const [name, setName] = useState('')
  const [targetId, setTargetId] = useState('')
  const [deploying, setDeploying] = useState(false)

  const reload = useCallback(async () => {
    if (!api) {
      return
    }
    const [nextTargets, nextPending] = await Promise.all([
      window.api.ssh.listTargets(),
      api.listPendingMigrations()
    ])
    if (mountedRef.current) {
      setTargets(nextTargets)
      setPending(nextPending)
    }
  }, [api, mountedRef])

  useEffect(() => {
    void reload().catch(() => undefined)
  }, [reload])

  if (!api) {
    return null
  }
  const managed = environments.filter((environment) => environment.orcadDeployment)
  const paired = environments.filter((environment) => !environment.orcadDeployment)

  const deploy = async (): Promise<void> => {
    setDeploying(true)
    try {
      const result = await api.deploy({ name: name.trim(), sshTargetId: targetId })
      if (result.outcome === 'deferred') {
        toast.message(result.reason)
      } else {
        setName('')
        setTargetId('')
      }
      onChanged()
      await reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      if (mountedRef.current) {
        setDeploying(false)
      }
    }
  }

  const resume = async (row: OrcadManagedPendingMigrationRow): Promise<void> => {
    try {
      const result = await api.convertSshHost({ sshTargetId: row.sshTargetId, name: row.name })
      if (result.outcome !== 'converted') {
        toast.message(result.reason)
      }
      onChanged()
      await reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="space-y-4" id="managed-servers">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">
          {translate('auto.components.settings.managedServers.title', 'Managed servers')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.managedServers.description',
            'Orca installs and runs a server on an empty SSH host and keeps it up to date.'
          )}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <Label>
            {translate('auto.components.settings.managedServers.deploy.host', 'SSH host')}
          </Label>
          <SshTargetSelect
            targets={targets}
            value={targetId}
            onChange={setTargetId}
            placeholder={translate(
              'auto.components.settings.managedServers.deploy.hostPlaceholder',
              'Choose an empty SSH host'
            )}
          />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <Label>
            {translate('auto.components.settings.managedServers.deploy.name', 'Server name')}
          </Label>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <Button
          type="button"
          disabled={deploying || targetId === '' || name.trim() === ''}
          onClick={() => void deploy()}
        >
          {translate('auto.components.settings.managedServers.deploy.submit', 'Deploy server')}
        </Button>
      </div>

      {pending.length > 0 ? (
        <div className="divide-y divide-border rounded-md border border-border">
          {pending.map((row) => (
            <div key={row.migrationId} className="flex items-center gap-2 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{row.name}</div>
                <p className="text-xs text-muted-foreground">{migrationPhaseLabel(row.phase)}</p>
              </div>
              <Button type="button" size="xs" variant="outline" onClick={() => void resume(row)}>
                {translate('auto.components.settings.managedServers.pending.resume', 'Resume')}
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {managed.length > 0 ? (
        <div className="divide-y divide-border rounded-md border border-border">
          {managed.map((environment) => (
            <ManagedServerRow
              key={environment.id}
              api={api}
              environment={environment}
              onChanged={onChanged}
            />
          ))}
        </div>
      ) : null}

      {paired.length > 0 ? (
        <div className="space-y-1">
          <Label>
            {translate(
              'auto.components.settings.managedServers.access.title',
              'SSH access for paired servers'
            )}
          </Label>
          <div className="divide-y divide-border rounded-md border border-border">
            {paired.map((environment) => (
              <RuntimeSshAccessControl
                key={environment.id}
                api={api}
                environment={environment}
                targets={targets}
                onChanged={onChanged}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
