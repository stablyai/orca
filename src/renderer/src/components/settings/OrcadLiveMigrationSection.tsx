import { useId, useRef, useState } from 'react'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { runtimeEnvironmentSshAccessBinding } from '../../../../shared/runtime-environment-authority-binding'
import type { SshTarget } from '../../../../shared/ssh-types'
import type { OrcadLiveMigrationProgress } from '../../../../shared/orcad-live-migration-recovery'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { isWebClientLocation } from '@/lib/web-client-location'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { OrcadLiveMigrationRow } from './OrcadLiveMigrationRow'
import { refreshOrcadMigrationRenderer } from '@/runtime/orcad-migration-renderer-refresh'

type Props = {
  environments: PublicKnownRuntimeEnvironment[]
  disabled?: boolean
  onConnectDestination: (environment: PublicKnownRuntimeEnvironment) => Promise<boolean>
}

function migrationErrorMessage(reason: unknown): string {
  const message = extractIpcErrorMessage(reason, String(reason))
  return message === 'pty_ownership_transfer_mutation_disabled'
    ? translate('orcadMigration.disabled', 'Experimental host migration is disabled in this app.')
    : message
}

export function OrcadLiveMigrationSection(props: Props): React.JSX.Element | null {
  const [selector, setSelector] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const fieldId = useId()
  const environment = props.environments.find((entry) => entry.id === selector)
  if (isWebClientLocation()) {
    return null
  }
  return (
    <section
      className="space-y-3 border-t pt-4"
      aria-label={translate('orcadMigration.title', 'SSH host migration')}
    >
      <div className="space-y-1">
        <h3 className="text-sm font-medium">
          {translate('orcadMigration.title', 'SSH host migration')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'orcadMigration.experimental',
            'Experimental: move a connected SSH target’s supported live terminals and workspace state to its paired server. Requires the migration opt-in; unsupported workloads are refused. This is not a file copy or a server deployment.'
          )}
        </p>
      </div>
      <Label htmlFor={fieldId}>
        {translate('orcadMigration.destination', 'Migration destination')}
      </Label>
      <Select value={selector} disabled={busy || props.disabled} onValueChange={setSelector}>
        <SelectTrigger id={fieldId}>
          <SelectValue
            placeholder={translate('orcadMigration.chooseDestination', 'Choose a paired server')}
          />
        </SelectTrigger>
        <SelectContent>
          {props.environments.map((entry) => (
            <SelectItem key={entry.id} value={entry.id}>
              {entry.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {environment ? (
        <MigrationDestinationForm
          key={JSON.stringify([environment.id, runtimeEnvironmentSshAccessBinding(environment)])}
          environment={environment}
          disabled={props.disabled || busy}
          pending={pending}
          onBusy={setBusy}
          onConnectDestination={props.onConnectDestination}
        />
      ) : null}
    </section>
  )
}

function MigrationDestinationForm({
  environment,
  disabled,
  pending,
  onBusy,
  onConnectDestination
}: {
  environment: PublicKnownRuntimeEnvironment
  disabled?: boolean
  pending: React.RefObject<boolean>
  onBusy: (busy: boolean) => void
  onConnectDestination: Props['onConnectDestination']
}): React.JSX.Element {
  const fieldId = useId()
  const [busy, setBusy] = useState(false)
  const [targets, setTargets] = useState<SshTarget[]>([])
  const [migrations, setMigrations] = useState<OrcadLiveMigrationProgress[] | null>(null)
  const [targetId, setTargetId] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const locked = busy || disabled
  const available = targets.filter(
    (target) =>
      !target.owner &&
      !target.orcadProvisioning &&
      !migrations?.some((entry) => entry.sourceSshTargetId === target.id)
  )
  const canStart =
    migrations !== null &&
    available.some((target) => target.id === targetId) &&
    !!environment.runtimeId

  const reload = async () => {
    setMigrations(null)
    const [saved, sourceTargets] = await Promise.all([
      window.api.runtimeEnvironments.listOrcadLiveMigrations({ selector: environment.id }),
      window.api.ssh.listTargets()
    ])
    setTargets(sourceTargets)
    setMigrations(saved)
  }
  const perform = async (operation: () => Promise<unknown>, mutation = false) => {
    if (pending.current || disabled) {
      return
    }
    pending.current = true
    setBusy(true)
    onBusy(true)
    setError('')
    setMessage('')
    if (mutation) {
      setMigrations(null)
    }
    const failures: string[] = []
    try {
      await operation()
    } catch (reason) {
      failures.push(migrationErrorMessage(reason))
    }
    try {
      // A rejected mutation may already have committed; reload evidence without retrying it.
      if (mutation) {
        await reload()
      }
    } catch (reason) {
      failures.push(migrationErrorMessage(reason))
    } finally {
      setError(failures.join('\n'))
      pending.current = false
      setBusy(false)
      onBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <Button variant="outline" size="sm" disabled={locked} onClick={() => void perform(reload)}>
        {translate('orcadMigration.load', 'Load migration status')}
      </Button>
      <p className="text-xs text-muted-foreground">
        {translate(
          'orcadMigration.warning',
          'A timeout may leave a migration in progress. Keep the original client open and preserve saved evidence; do not reset or redeploy the source. Status is loaded on request, not monitored automatically.'
        )}
      </p>
      {migrations !== null ? (
        <>
          {migrations.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {translate('orcadMigration.empty', 'No saved host migrations for this server.')}
            </p>
          ) : null}
          {migrations.map((entry) => (
            <OrcadLiveMigrationRow
              key={entry.migrationId}
              entry={entry}
              disabled={!!locked}
              onContinue={(mode) =>
                void perform(
                  () =>
                    entry.phaseEvidence === 'intent-only'
                      ? window.api.runtimeEnvironments.startOrcadLiveMigration({
                          selector: environment.id,
                          targetId: entry.sourceSshTargetId
                        })
                      : window.api.runtimeEnvironments.resumeOrcadLiveMigration({
                          selector: environment.id,
                          migrationId: entry.migrationId,
                          mode
                        }),
                  true
                )
              }
              onConnect={() =>
                void perform(async () => {
                  if (
                    !(await refreshOrcadMigrationRenderer(
                      environment,
                      entry.migrationId,
                      onConnectDestination
                    ))
                  ) {
                    throw new Error(
                      translate(
                        'orcadMigration.connectFailed',
                        'Could not refresh the destination catalog. Migration status is unchanged.'
                      )
                    )
                  }
                  setMessage(
                    translate(
                      'orcadMigration.catalogLoaded',
                      'Destination catalog refreshed. The active server has not changed; open the migrated workspace to inspect its panes.'
                    )
                  )
                })
              }
            />
          ))}
          <Label htmlFor={fieldId}>{translate('orcadMigration.source', 'Source SSH target')}</Label>
          <Select value={targetId} disabled={locked} onValueChange={setTargetId}>
            <SelectTrigger id={fieldId}>
              <SelectValue
                placeholder={translate('orcadMigration.chooseSource', 'Choose a source target')}
              />
            </SelectTrigger>
            <SelectContent>
              {available.map((target) => (
                <SelectItem key={target.id} value={target.id}>
                  {target.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            disabled={locked || !canStart}
            onClick={() => {
              if (canStart) {
                void perform(
                  () =>
                    window.api.runtimeEnvironments.startOrcadLiveMigration({
                      selector: environment.id,
                      targetId
                    }),
                  true
                )
              }
            }}
          >
            {translate('orcadMigration.start', 'Start host migration')}
          </Button>
          {!available.length ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'orcadMigration.noSources',
                'No unowned source targets are available. Connect a source in SSH Hosts, or continue a saved migration above.'
              )}
            </p>
          ) : null}
        </>
      ) : null}
      {busy ? (
        <p role="status" className="text-xs text-muted-foreground">
          {translate('orcadMigration.working', 'Processing migration request…')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="whitespace-pre-wrap break-words text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
    </div>
  )
}
