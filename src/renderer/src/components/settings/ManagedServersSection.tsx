import { Loader2 } from 'lucide-react'
import { useCallback, useEffect, useId, useState } from 'react'
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
import { managedServerOutcomeLabel, migrationPhaseLabel } from './managed-server-copy'

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
  const [resumingId, setResumingId] = useState<string | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const hostFieldId = useId()
  const nameFieldId = useId()

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
      setLoadFailed(false)
    }
  }, [api, mountedRef])

  useEffect(() => {
    void reload().catch(() => mountedRef.current && setLoadFailed(true))
  }, [mountedRef, reload])

  if (!api) {
    return null
  }
  const managed = environments.filter((environment) => environment.orcadDeployment)
  const paired = environments.filter((environment) => !environment.orcadDeployment)
  // Why: a host that already runs, or is moving to, a managed server can't take another.
  const busyTargetIds = new Set([
    ...managed.map((environment) => environment.orcadDeployment?.sshTargetId),
    ...pending.map((row) => row.sshTargetId)
  ])
  const emptyTargets = targets.filter(
    (target) => !target.orcadFence && !busyTargetIds.has(target.id)
  )

  const deploy = async (): Promise<void> => {
    setDeploying(true)
    try {
      const result = await api.deploy({ name: name.trim(), sshTargetId: targetId })
      if (result.outcome === 'deferred') {
        toast.message(managedServerOutcomeLabel(result))
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
    if (resumingId) {
      return
    }
    setResumingId(row.migrationId)
    try {
      const result = await api.convertSshHost({ sshTargetId: row.sshTargetId, name: row.name })
      if (result.outcome !== 'converted') {
        toast.message(managedServerOutcomeLabel(result))
      }
      onChanged()
      await reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      if (mountedRef.current) {
        setResumingId(null)
      }
    }
  }

  return (
    <div className="space-y-4" data-settings-section="managed-servers">
      <div className="space-y-0.5">
        <div className="text-sm font-medium">
          {translate('auto.components.settings.managedServers.title', 'Managed servers')}
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.managedServers.description',
            'Orca installs and runs a server on an empty SSH host and keeps it up to date.'
          )}
        </p>
        {loadFailed ? (
          <p className="text-xs text-destructive">
            {translate(
              'auto.components.settings.managedServers.loadFailed',
              'Orca couldn’t load SSH hosts and unfinished moves. Reopen Settings to try again.'
            )}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor={hostFieldId}>
            {translate('auto.components.settings.managedServers.deploy.host', 'SSH host')}
          </Label>
          <SshTargetSelect
            id={hostFieldId}
            targets={emptyTargets}
            value={targetId}
            onChange={setTargetId}
            placeholder={translate(
              'auto.components.settings.managedServers.deploy.hostPlaceholder',
              'Choose an empty SSH host'
            )}
          />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor={nameFieldId}>
            {translate('auto.components.settings.managedServers.deploy.name', 'Server name')}
          </Label>
          <Input id={nameFieldId} value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <Button
          type="button"
          disabled={deploying || targetId === '' || name.trim() === ''}
          onClick={() => void deploy()}
        >
          {deploying ? <Loader2 className="animate-spin" /> : null}
          {deploying
            ? translate('auto.components.settings.managedServers.deploy.running', 'Deploying…')
            : translate('auto.components.settings.managedServers.deploy.submit', 'Deploy server')}
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
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={resumingId !== null}
                onClick={() => void resume(row)}
              >
                {resumingId === row.migrationId ? <Loader2 className="animate-spin" /> : null}
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
