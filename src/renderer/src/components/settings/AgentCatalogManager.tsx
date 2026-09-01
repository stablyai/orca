import { Plus, RefreshCw } from 'lucide-react'
import { Button } from '../ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { SettingsSubsectionHeader } from './SettingsFormControls'
import { AgentCatalogList } from './AgentCatalogList'
import type { AgentCatalogRow } from './agent-catalog-rows'
import type {
  AgentCatalogActionAvailability,
  AgentCatalogRowCallbacks
} from './AgentCatalogRowView'

export type AgentCatalogManagerProps = {
  rows: readonly AgentCatalogRow[]
  /** Paired web renders the catalog view-only; hides the New action. */
  readOnly?: boolean
  availability?: AgentCatalogActionAvailability
  isRefreshing?: boolean
  onNewAgent: () => void
  /** The existing PATH re-detection action; kept on the catalog so
   *  "install → refresh" stays a closed loop (plan §976). */
  onRefresh?: () => void
} & AgentCatalogRowCallbacks

export function AgentCatalogManager({
  rows,
  readOnly,
  availability,
  isRefreshing,
  onNewAgent,
  onRefresh,
  ...callbacks
}: AgentCatalogManagerProps): React.JSX.Element {
  // Zero-custom = the user has defined no agents of their own (customs, repair,
  // or tombstones) — built-ins alone do not count.
  const hasUserAgents = rows.some((row) => row.kind !== 'built-in')
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={translate('auto.components.settings.AgentCatalogManager.title', 'Agents')}
        action={
          <div className="flex items-center gap-1.5">
            {onRefresh ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={onRefresh}
                // Why: read-only disabling is scoped per control (no ancestor
                // fieldset) so the catalog search box stays usable.
                disabled={isRefreshing || readOnly}
                className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <RefreshCw className={cn('size-3', isRefreshing && 'animate-spin')} />
                {isRefreshing
                  ? translate(
                      'auto.components.settings.AgentCatalogManager.refreshing',
                      'Refreshing…'
                    )
                  : translate('auto.components.settings.AgentCatalogManager.refresh', 'Refresh')}
              </Button>
            ) : null}
            {readOnly ? null : (
              <Button type="button" size="xs" onClick={onNewAgent} className="gap-1.5">
                <Plus className="size-3.5" />
                {translate('auto.components.settings.AgentCatalogManager.newAgent', 'New agent')}
              </Button>
            )}
          </div>
        }
      />
      {!hasUserAgents && (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.AgentCatalogManager.zeroCustomHelper',
            'Duplicate a built-in or create a custom agent to save alternate args and env.'
          )}
        </p>
      )}
      <AgentCatalogList
        rows={rows}
        readOnly={readOnly}
        availability={availability}
        {...callbacks}
      />
    </section>
  )
}
