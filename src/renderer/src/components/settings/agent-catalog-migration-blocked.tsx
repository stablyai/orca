import { AlertTriangle } from 'lucide-react'
import { translate } from '@/i18n/i18n'

// Why: while the pinned pre-v1 backup is failing, main fail-closes every
// catalog/reference write with this code. It is minted in main's write policy
// and is not part of the shared mutation-result unions, so renderer consumers
// narrow it structurally here instead of widening the shared types.

export type AgentCatalogMigrationBlockedResult = {
  ok: false
  code: 'agent_catalog_migration_blocked'
  migrationError: string
}

/** Narrows any catalog/reference mutation result to the migration-blocked
 *  rejection, or null when the result is a success or a different failure. */
export function asAgentCatalogMigrationBlocked(result: {
  ok: boolean
}): AgentCatalogMigrationBlockedResult | null {
  if (result.ok) {
    return null
  }
  const candidate = result as { code?: unknown; migrationError?: unknown }
  if (candidate.code !== 'agent_catalog_migration_blocked') {
    return null
  }
  return {
    ok: false,
    code: 'agent_catalog_migration_blocked',
    migrationError: typeof candidate.migrationError === 'string' ? candidate.migrationError : ''
  }
}

/** Persistent (no dismiss affordance) read-only explanation shown once a
 *  mutation is rejected because the pre-update backup failed. */
export function AgentCatalogMigrationBlockedNotice({
  migrationError
}: {
  migrationError: string
}): React.JSX.Element {
  return (
    <div
      role="alert"
      className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
    >
      <p className="flex items-start gap-2 font-medium text-destructive">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <span>
          {translate(
            'auto.components.settings.AgentCatalogSection.migrationBlockedTitle',
            'Agent settings are temporarily read-only'
          )}
        </span>
      </p>
      <p className="text-muted-foreground">
        {translate(
          'auto.components.settings.AgentCatalogSection.migrationBlockedDescription',
          'Orca could not back up your existing agent settings before updating them, so changes are blocked to protect your data. Resolve the problem below, then try again.'
        )}
      </p>
      {migrationError ? (
        <p className="break-words font-mono text-xs text-muted-foreground">{migrationError}</p>
      ) : null}
    </div>
  )
}
