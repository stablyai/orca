import { LoaderCircle, RefreshCw, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  type AiVaultAgent,
  type AiVaultGroup,
  type AiVaultScope,
  type AiVaultSort
} from '../../../../shared/ai-vault-types'
import { VaultScopeSwitch, VaultViewMenu } from './AiVaultPanelControls'

type AiVaultPanelHeaderProps = {
  query: string
  loading: boolean
  shownCount: number
  sessionCount: number
  hasScanResult: boolean
  activeWorktreePath: string | null
  scope: AiVaultScope
  agents: readonly AiVaultAgent[]
  sort: AiVaultSort
  group: AiVaultGroup
  hideEmptySessions: boolean
  adjustmentCount: number
  onQueryChange: (query: string) => void
  onScopeChange: (scope: AiVaultScope) => void
  onAgentEnabledChange: (agent: AiVaultAgent, enabled: boolean) => void
  onSortChange: (sort: AiVaultSort) => void
  onGroupChange: (group: AiVaultGroup) => void
  onHideEmptySessionsChange: (hideEmptySessions: boolean) => void
  onReset: () => void
  onRefresh: () => void
}

export function AiVaultPanelHeader({
  query,
  loading,
  shownCount,
  sessionCount,
  hasScanResult,
  activeWorktreePath,
  scope,
  agents,
  sort,
  group,
  hideEmptySessions,
  adjustmentCount,
  onQueryChange,
  onScopeChange,
  onAgentEnabledChange,
  onSortChange,
  onGroupChange,
  onHideEmptySessionsChange,
  onReset,
  onRefresh
}: AiVaultPanelHeaderProps): React.JSX.Element {
  return (
    <div className="shrink-0 border-b border-sidebar-border px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-foreground">
            {translate(
              'auto.components.right.sidebar.AiVaultPanel.sessionHistory',
              'Agent Session History'
            )}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {hasScanResult
              ? translate(
                  'auto.components.right.sidebar.AiVaultPanel.shownRecent',
                  '{{value0}} shown · {{value1}} recent',
                  { value0: shownCount, value1: sessionCount }
                )
              : translate(
                  'auto.components.right.sidebar.AiVaultPanel.resumePastSessions',
                  'Resume past sessions'
                )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <VaultScopeSwitch
            scope={scope}
            workspaceAvailable={Boolean(activeWorktreePath)}
            onScopeChange={onScopeChange}
          />
          <VaultViewMenu
            agents={agents}
            sort={sort}
            group={group}
            hideEmptySessions={hideEmptySessions}
            adjustmentCount={adjustmentCount}
            onAgentEnabledChange={onAgentEnabledChange}
            onSortChange={onSortChange}
            onGroupChange={onGroupChange}
            onHideEmptySessionsChange={onHideEmptySessionsChange}
            onReset={onReset}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={translate(
              'auto.components.right.sidebar.AiVaultPanel.refreshSessionHistory',
              'Refresh Session History'
            )}
            onClick={onRefresh}
            disabled={loading}
            aria-busy={loading}
            className="size-6"
          >
            {loading ? (
              <LoaderCircle className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
          </Button>
        </div>
      </div>

      <div className="mt-2 flex h-8 items-center gap-1.5 rounded-md border border-sidebar-border bg-input/50 px-2 focus-within:border-sidebar-ring focus-within:ring-[2px] focus-within:ring-sidebar-ring/30">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={translate(
            'auto.components.right.sidebar.AiVaultPanel.searchSessions',
            'Search sessions'
          )}
          className="min-w-0 flex-1 bg-transparent py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/50"
          spellCheck={false}
        />
        {loading ? <LoaderCircle className="size-3 animate-spin text-muted-foreground" /> : null}
        {query ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-5 rounded-sm text-muted-foreground hover:text-foreground"
            onClick={() => onQueryChange('')}
            aria-label={translate(
              'auto.components.right.sidebar.AiVaultPanel.clearSearch',
              'Clear search'
            )}
          >
            <X className="size-3" />
          </Button>
        ) : null}
      </div>
    </div>
  )
}
