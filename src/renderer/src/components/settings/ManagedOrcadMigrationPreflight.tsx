import { Loader2 } from 'lucide-react'
import type { OrcadMigrationBlocker } from '../../../../shared/orcad-migration-preflight'
import { translate } from '@/i18n/i18n'
import type { ManagedOrcadTargetPreflightEntry } from './use-managed-orcad-servers'

type ManagedOrcadMigrationPreflightProps = {
  entry: ManagedOrcadTargetPreflightEntry | null
  targetId: string
}

export function ManagedOrcadMigrationPreflight({
  entry,
  targetId
}: ManagedOrcadMigrationPreflightProps): React.JSX.Element | null {
  if (!entry || entry.targetId !== targetId) {
    return null
  }
  if (entry.state === 'loading') {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
        <Loader2 className="size-3.5 animate-spin" />
        {translate(
          'auto.components.settings.ManagedOrcadServersSection.checkingMigration',
          'Checking persisted SSH ownership…'
        )}
      </div>
    )
  }
  if (entry.state === 'error') {
    return (
      <p className="text-xs text-destructive" role="alert">
        {entry.message}
      </p>
    )
  }
  if (entry.preflight.claimable && entry.preflight.blockers.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" role="status">
        {translate(
          'auto.components.settings.ManagedOrcadServersSection.noMigrationBlockers',
          'No persisted migration blockers found.'
        )}
      </p>
    )
  }
  const migratesStaticState = entry.preflight.claimable
  return (
    <div
      className="space-y-2 rounded-md border border-border/50 bg-muted/30 p-2.5"
      role={migratesStaticState ? 'status' : 'alert'}
    >
      <p className="text-xs font-medium">
        {migratesStaticState
          ? translate(
              'auto.components.settings.ManagedOrcadServersSection.migrationReady',
              'This direct SSH catalog will move to the managed server:'
            )
          : translate(
              'auto.components.settings.ManagedOrcadServersSection.migrationBlocked',
              'This host still has direct SSH ownership:'
            )}
      </p>
      <ul className="space-y-1.5 text-xs">
        {entry.preflight.blockers.map((blocker) => (
          <ManagedOrcadMigrationBlockerItems key={blocker.code} blocker={blocker} />
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        {migratesStaticState
          ? translate(
              'auto.components.settings.ManagedOrcadServersSection.migrationWillMove',
              'Deploy will transfer these rows transactionally. No terminals or dependent workspace state will be ended.'
            )
          : translate(
              'auto.components.settings.ManagedOrcadServersSection.migrationUnchanged',
              'Deployment remains blocked. This check did not change any workspaces, terminals, or forwards.'
            )}
      </p>
    </div>
  )
}

function ManagedOrcadMigrationBlockerItems({
  blocker
}: {
  blocker: OrcadMigrationBlocker
}): React.JSX.Element {
  switch (blocker.code) {
    case 'orcad_migration_target_not_found':
      return <li>{translate('auto.orcadMigration.targetMissing', 'SSH target not found.')}</li>
    case 'orcad_migration_target_owned':
      return (
        <li>
          {translate('auto.orcadMigration.targetOwned', 'Another runtime owns this SSH target.')}
        </li>
      )
    case 'orcad_migration_direct_ssh_repositories':
      return (
        <li>
          <span className="font-medium">
            {blocker.repositories.length === 1
              ? translate('auto.orcadMigration.oneRepository', '1 repository')
              : translate('auto.orcadMigration.repositories', '{{value0}} repositories', {
                  value0: blocker.repositories.length
                })}
          </span>
          {blocker.repositories.map((repo) => (
            <span
              key={repo.id}
              className="block break-all font-mono text-[11px] text-muted-foreground"
            >
              {repo.displayName} · {repo.path}
            </span>
          ))}
        </li>
      )
    case 'orcad_migration_direct_ssh_folder_workspaces':
      return (
        <li>
          <span className="font-medium">
            {blocker.folderWorkspaces.length === 1
              ? translate('auto.orcadMigration.oneFolderWorkspace', '1 folder workspace')
              : translate('auto.orcadMigration.folderWorkspaces', '{{value0}} folder workspaces', {
                  value0: blocker.folderWorkspaces.length
                })}
          </span>
          {blocker.folderWorkspaces.map((workspace) => (
            <span
              key={workspace.id}
              className="block break-all font-mono text-[11px] text-muted-foreground"
            >
              {workspace.name} · {workspace.folderPath}
            </span>
          ))}
        </li>
      )
    case 'orcad_migration_direct_ssh_terminal_leases':
      return (
        <li>
          <span className="font-medium">
            {blocker.terminalLeases.length === 1
              ? translate('auto.orcadMigration.oneTerminalLease', '1 live or unverifiable terminal')
              : translate(
                  'auto.orcadMigration.terminalLeases',
                  '{{value0}} live or unverifiable terminals',
                  { value0: blocker.terminalLeases.length }
                )}
          </span>
          {blocker.terminalLeases.map((lease) => (
            <span key={lease.ptyId} className="block font-mono text-[11px] text-muted-foreground">
              {lease.ptyId} · {lease.state}
            </span>
          ))}
        </li>
      )
    case 'orcad_migration_saved_port_forwards':
      return (
        <li>
          <span className="font-medium">
            {blocker.portForwards.length === 1
              ? translate('auto.orcadMigration.onePortForward', '1 saved port forward')
              : translate('auto.orcadMigration.portForwards', '{{value0}} saved port forwards', {
                  value0: blocker.portForwards.length
                })}
          </span>
          {blocker.portForwards.map((forward) => (
            <span
              key={`${forward.localPort}:${forward.remoteHost}:${forward.remotePort}`}
              className="block break-all font-mono text-[11px] text-muted-foreground"
            >
              {translate(
                'auto.orcadMigration.portForwardAddress',
                '{{localAddress}} → {{remoteAddress}}',
                {
                  localAddress: `localhost:${forward.localPort}`,
                  remoteAddress: `${forward.remoteHost}:${forward.remotePort}`
                }
              )}
            </span>
          ))}
        </li>
      )
    case 'orcad_migration_dependent_state':
      return (
        <li>
          <span className="font-medium">
            {translate(
              'auto.orcadMigration.dependentState',
              'Dependent workspace state cannot move yet'
            )}
          </span>
          {blocker.dependencies.map((dependency) => (
            <span
              key={dependency.kind}
              className="block font-mono text-[11px] text-muted-foreground"
            >
              {dependency.kind} · {dependency.count}
            </span>
          ))}
        </li>
      )
  }
}
