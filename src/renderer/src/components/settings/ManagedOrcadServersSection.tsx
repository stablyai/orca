import { Loader2, Plus, RefreshCw } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { ManagedOrcadDeploymentForm } from './ManagedOrcadDeploymentForm'
import { ManagedOrcadPendingMigrationRow } from './ManagedOrcadPendingMigrationRow'
import { ManagedOrcadServerDialogs } from './ManagedOrcadServerDialogs'
import { ManagedOrcadServerRow } from './ManagedOrcadServerRow'
import { managedOrcadPendingSetupId } from './managed-orcad-server-types'
import {
  type ManagedOrcadForceOperation,
  useManagedOrcadServers
} from './use-managed-orcad-servers'

type ManagedOrcadServersSectionProps = {
  activeEnvironmentId: string | null | undefined
  onEnvironmentsChanged: () => Promise<void> | void
}

export function ManagedOrcadServersSection({
  activeEnvironmentId,
  onEnvironmentsChanged
}: ManagedOrcadServersSectionProps): React.JSX.Element {
  const state = useManagedOrcadServers(onEnvironmentsChanged)
  const busy = state.busyAction !== null

  const force = (operation: ManagedOrcadForceOperation): void => {
    state.setForceOperation(null)
    if (operation.kind === 'create') {
      void state.deploy({
        name: operation.name,
        sshTargetId: operation.sshTargetId,
        force: true
      })
      return
    }
    if (operation.kind === 'resume') {
      void state.resumeMigration(operation, true)
      return
    }
    void state.update(operation.environmentId, true)
  }

  return (
    <section data-settings-section="managed-orcad-servers" className="space-y-3 border-b pb-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <div className="text-sm font-medium">
            {translate(
              'auto.components.settings.ManagedOrcadServersSection.title',
              'Managed Orca servers'
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ManagedOrcadServersSection.description',
              'Install and maintain orcad on an SSH host. Orca owns the SSH target while the server is linked.'
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => void state.load()}
            disabled={state.loading || busy}
            aria-label={translate(
              'auto.components.settings.ManagedOrcadServersSection.refresh',
              'Refresh managed servers'
            )}
          >
            <RefreshCw className={state.loading ? 'animate-spin' : undefined} />
          </Button>
          {!state.formOpen ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => state.setFormOpen(true)}
              disabled={busy}
            >
              <Plus />
              {translate(
                'auto.components.settings.ManagedOrcadServersSection.add',
                'Deploy Server'
              )}
            </Button>
          ) : null}
        </div>
      </div>

      {state.formOpen ? (
        <ManagedOrcadDeploymentForm
          busyAction={state.busyAction}
          error={state.createError}
          name={state.name}
          preflight={state.targetPreflight}
          sshTargetId={state.sshTargetId}
          targets={state.targets}
          onNameChange={state.setName}
          onTargetChange={state.selectSshTarget}
          onErrorClear={() => state.setCreateError(null)}
          onCancel={() => {
            state.setFormOpen(false)
            state.setCreateError(null)
            state.selectSshTarget('')
          }}
          onDeploy={(input) => void state.deploy(input)}
        />
      ) : null}

      {state.loadError ? <p className="text-xs text-destructive">{state.loadError}</p> : null}
      <div className="rounded-lg border border-border/50 bg-card/30">
        {state.loading && state.environments.length === 0 && state.pendingSetups.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {translate(
              'auto.components.settings.ManagedOrcadServersSection.loading',
              'Checking managed servers…'
            )}
          </div>
        ) : state.loadError &&
          state.environments.length === 0 &&
          state.pendingSetups.length === 0 ? null : state.environments.length === 0 &&
          state.pendingSetups.length === 0 ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">
            {translate(
              'auto.components.settings.ManagedOrcadServersSection.empty',
              'No managed Orca servers.'
            )}
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {state.pendingSetups.map((migration) => (
              <ManagedOrcadPendingMigrationRow
                key={managedOrcadPendingSetupId(migration)}
                migration={migration}
                busyAction={state.busyAction}
                error={state.rowErrors[managedOrcadPendingSetupId(migration)]}
                onResume={() =>
                  void ('requestId' in migration
                    ? state.resumeProvisioning(migration)
                    : state.resumeMigration(migration))
                }
              />
            ))}
            {state.environments.map((environment) => (
              <ManagedOrcadServerRow
                key={environment.id}
                environment={environment}
                statusEntry={state.statuses[environment.id]}
                error={state.rowErrors[environment.id]}
                isActive={activeEnvironmentId === environment.id}
                busyAction={state.busyAction}
                onRecover={() => void state.recover(environment.id)}
                onCancelStop={() => void state.cancelStop(environment.id)}
                onResume={() =>
                  void state.resumeMigration({
                    environmentId: environment.id,
                    name: environment.name,
                    sshTargetId: environment.orcadDeployment!.sshTargetId
                  })
                }
                onUpdate={() => void state.update(environment.id)}
                onConfirm={state.setConfirmation}
              />
            ))}
          </div>
        )}
      </div>

      <ManagedOrcadServerDialogs
        confirmation={state.confirmation}
        forceOperation={state.forceOperation}
        onConfirmationChange={state.setConfirmation}
        onForceOperationChange={state.setForceOperation}
        onForce={force}
        onRollback={(environmentId) => void state.rollback(environmentId)}
        onStop={(environmentId) => void state.stopAndUnlink(environmentId)}
      />
    </section>
  )
}
