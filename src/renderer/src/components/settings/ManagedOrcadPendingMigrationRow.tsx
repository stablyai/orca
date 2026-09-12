import { Loader2, ServerCog, ShieldCheck } from 'lucide-react'
import type { OrcadManagedPendingMigration } from '../../../../shared/orcad-managed-runtime'
import { translate } from '@/i18n/i18n'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import type { ManagedOrcadBusyAction } from './use-managed-orcad-servers'
import {
  managedOrcadPendingSetupId,
  type ManagedOrcadPendingSetup
} from './managed-orcad-server-types'

type ManagedOrcadPendingMigrationRowProps = {
  busyAction: ManagedOrcadBusyAction | null
  error?: string
  migration: ManagedOrcadPendingSetup
  onResume: () => void
}

export function ManagedOrcadPendingMigrationRow({
  busyAction,
  error,
  migration,
  onResume
}: ManagedOrcadPendingMigrationRowProps): React.JSX.Element {
  const actionBusy = busyAction?.id === managedOrcadPendingSetupId(migration)
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <ServerCog className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{migration.name}</span>
          <Badge variant="outline">
            {translate(
              'auto.components.settings.ManagedOrcadServersSection.setupInterrupted',
              'Setup interrupted'
            )}
          </Badge>
        </div>
        {'sshTargetLabel' in migration ? (
          <p className="text-xs text-muted-foreground">{migration.sshTargetLabel}</p>
        ) : null}
        <p className="text-xs text-destructive">
          {'phase' in migration
            ? managedOrcadMigrationDescription(migration.phase)
            : translate(
                'auto.components.settings.ManagedOrcadServersSection.provisioningPending',
                'Setup has not completed. The SSH host remains reserved; resume setup to retry.'
              )}
        </p>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
      <Button type="button" size="xs" onClick={onResume} disabled={busyAction !== null}>
        {actionBusy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
        {translate(
          'auto.components.settings.ManagedOrcadServersSection.resumeSetup',
          'Resume setup'
        )}
      </Button>
    </div>
  )
}

export function managedOrcadMigrationDescription(
  phase: OrcadManagedPendingMigration['phase']
): string {
  switch (phase) {
    case 'source-fenced':
      return translate(
        'auto.components.settings.ManagedOrcadServersSection.sourceFencedMigration',
        'Setup stopped before the catalog was committed. The SSH target remains reserved.'
      )
    case 'destination-staged':
      return translate(
        'auto.components.settings.ManagedOrcadServersSection.destinationStagedMigration',
        'Catalog transfer was staged but not committed. The SSH target remains reserved.'
      )
    case 'destination-committed':
      return translate(
        'auto.components.settings.ManagedOrcadServersSection.destinationCommittedMigration',
        'Catalog transfer committed, but source cleanup did not finish.'
      )
    case 'source-retired':
      return translate(
        'auto.components.settings.ManagedOrcadServersSection.sourceRetiredMigration',
        'Catalog transfer completed, but the local server registration is missing.'
      )
  }
}
