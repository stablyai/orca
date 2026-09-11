import { LoaderCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type {
  AiVaultAgent,
  AiVaultGroup,
  AiVaultScope,
  AiVaultSessionHost,
  AiVaultSort,
  AiVaultTimeRange
} from '../../../../shared/ai-vault-types'
import type { ExecutionHostScope } from '../../../../shared/execution-host'
import type { AiVaultSearchScope } from '../../../../shared/ai-vault-session-search-scope'
import { VaultHostScopeMenu, VaultScopeSwitch, VaultViewMenu } from './AiVaultPanelControls'
import { AiVaultSearchField } from './AiVaultSearchField'
import type { AiVaultHostScopeOption } from './ai-vault-host-scope'
import type { AiVaultSessionLimit } from './ai-vault-session-limit'

export type AiVaultPanelHeaderProps = {
  query: string
  loading: boolean
  shownCount: number
  sessionCount: number
  hasScanResult: boolean
  activeWorktreePath: string | null
  activeProjectKey: string | null
  scope: AiVaultScope
  executionHostScope: ExecutionHostScope
  hostScopeOptions: readonly AiVaultHostScopeOption[]
  agents: readonly AiVaultAgent[]
  sort: AiVaultSort
  group: AiVaultGroup
  hideEmptySessions: boolean
  sessionLimit: AiVaultSessionLimit
  timeRange: AiVaultTimeRange
  hosts: readonly AiVaultSessionHost[]
  adjustmentCount: number
  aiLoading: boolean
  usedModel: boolean
  aiAgentConfigured: boolean
  searchScope: AiVaultSearchScope
  rgLoading: boolean
  rgHitCount: number | null
  onQueryChange: (query: string) => void
  onSearchScopeChange: (searchScope: AiVaultSearchScope) => void
  onScopeChange: (scope: AiVaultScope) => void
  onExecutionHostScopeChange: (scope: ExecutionHostScope) => void
  onAgentEnabledChange: (agent: AiVaultAgent, enabled: boolean) => void
  onAllAgentsEnabledChange: (enabled: boolean) => void
  onSortChange: (sort: AiVaultSort) => void
  onGroupChange: (group: AiVaultGroup) => void
  onHideEmptySessionsChange: (hideEmptySessions: boolean) => void
  onSessionLimitChange: (limit: AiVaultSessionLimit) => void
  onTimeRangeChange: (timeRange: AiVaultTimeRange) => void
  onHostEnabledChange: (host: AiVaultSessionHost, enabled: boolean) => void
  onAiSearch: () => void
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
  activeProjectKey,
  scope,
  executionHostScope,
  hostScopeOptions,
  agents,
  sort,
  group,
  hideEmptySessions,
  sessionLimit,
  timeRange,
  hosts,
  adjustmentCount,
  aiLoading,
  usedModel,
  aiAgentConfigured,
  searchScope,
  rgLoading,
  rgHitCount,
  onQueryChange,
  onSearchScopeChange,
  onScopeChange,
  onExecutionHostScopeChange,
  onAgentEnabledChange,
  onAllAgentsEnabledChange,
  onSortChange,
  onGroupChange,
  onHideEmptySessionsChange,
  onSessionLimitChange,
  onTimeRangeChange,
  onHostEnabledChange,
  onAiSearch,
  onReset,
  onRefresh
}: AiVaultPanelHeaderProps): React.JSX.Element {
  return (
    <div className="shrink-0 border-b border-sidebar-border px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-foreground">
            {/* Why: below 300px the header competes with fixed controls, so compact copy prevents overlap. */}
            <span className="@max-[300px]/ai-vault:hidden">
              {translate(
                'auto.components.right.sidebar.AiVaultPanel.sessionHistory',
                'Agent Session History'
              )}
            </span>
            <span className="hidden @max-[300px]/ai-vault:inline">
              {translate('auto.components.right.sidebar.AiVaultPanel.agents', 'Agents')}
            </span>
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {hasScanResult ? (
              <>
                <span className="@max-[300px]/ai-vault:hidden">
                  {translate(
                    'auto.components.right.sidebar.AiVaultPanel.shownRecent',
                    '{{value0}} shown · {{value1}} recent',
                    { value0: shownCount, value1: sessionCount }
                  )}
                </span>
                <span className="hidden @max-[300px]/ai-vault:inline">
                  {translate(
                    'auto.components.right.sidebar.AiVaultPanel.sessionsShownCompact',
                    '{{value0}} shown',
                    { value0: shownCount }
                  )}
                </span>
              </>
            ) : (
              translate(
                'auto.components.right.sidebar.AiVaultPanel.resumePastSessions',
                'Resume past sessions'
              )
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 @max-[300px]/ai-vault:gap-0.5">
          <VaultHostScopeMenu
            executionHostScope={executionHostScope}
            hostOptions={hostScopeOptions}
            onExecutionHostScopeChange={onExecutionHostScopeChange}
          />
          <VaultViewMenu
            agents={agents}
            sort={sort}
            group={group}
            hideEmptySessions={hideEmptySessions}
            sessionLimit={sessionLimit}
            timeRange={timeRange}
            hosts={hosts}
            searchScope={searchScope}
            adjustmentCount={adjustmentCount}
            onAgentEnabledChange={onAgentEnabledChange}
            onAllAgentsEnabledChange={onAllAgentsEnabledChange}
            onSortChange={onSortChange}
            onGroupChange={onGroupChange}
            onHideEmptySessionsChange={onHideEmptySessionsChange}
            onSessionLimitChange={onSessionLimitChange}
            onTimeRangeChange={onTimeRangeChange}
            onHostEnabledChange={onHostEnabledChange}
            onSearchScopeChange={onSearchScopeChange}
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

      <div className="mt-2">
        <VaultScopeSwitch
          scope={scope}
          workspaceAvailable={Boolean(activeWorktreePath)}
          projectAvailable={Boolean(activeProjectKey)}
          onScopeChange={onScopeChange}
        />
      </div>

      <AiVaultSearchField
        query={query}
        loading={loading}
        aiLoading={aiLoading}
        usedModel={usedModel}
        aiAgentConfigured={aiAgentConfigured}
        searchScope={searchScope}
        rgLoading={rgLoading}
        rgHitCount={rgHitCount}
        onQueryChange={onQueryChange}
        onSearchScopeChange={onSearchScopeChange}
        onAiSearch={onAiSearch}
      />
    </div>
  )
}
