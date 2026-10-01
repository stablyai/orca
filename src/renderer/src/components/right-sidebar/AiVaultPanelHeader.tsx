import { useEffect, useRef } from 'react'
import { LoaderCircle, RefreshCw, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { AiVaultAgent, AiVaultGroup, AiVaultScope } from '../../../../shared/ai-vault-types'
import type { ExecutionHostScope } from '../../../../shared/execution-host'
import { VaultHostScopeMenu, VaultScopeSwitch, VaultViewMenu } from './AiVaultPanelControls'
import type { AiVaultHostScopeOption } from './ai-vault-host-scope'
import type { AiVaultSessionLimit } from './ai-vault-session-limit'

type AiVaultPanelHeaderProps = {
  searching?: boolean
  query: string
  loading: boolean
  hasScanResult: boolean
  activeWorktreePath: string | null
  activeProjectKey: string | null
  scope: AiVaultScope
  executionHostScope: ExecutionHostScope
  hostScopeOptions: readonly AiVaultHostScopeOption[]
  agents: readonly AiVaultAgent[]
  group: AiVaultGroup
  hideEmptySessions: boolean
  sessionLimit: AiVaultSessionLimit
  adjustmentCount: number
  /** Bumped by a caller that sent the user here, e.g. Settings; focuses the search box once. */
  focusSearchRequestId?: number
  onQueryChange: (query: string) => void
  onScopeChange: (scope: AiVaultScope) => void
  onExecutionHostScopeChange: (scope: ExecutionHostScope) => void
  onAgentEnabledChange: (agent: AiVaultAgent, enabled: boolean) => void
  onAllAgentsEnabledChange: (enabled: boolean) => void
  onGroupChange: (group: AiVaultGroup) => void
  onHideEmptySessionsChange: (hideEmptySessions: boolean) => void
  onSessionLimitChange: (limit: AiVaultSessionLimit) => void
  onReset: () => void
  onRefresh: () => void
}

export function AiVaultPanelHeader({
  query,
  searching = false,
  loading,
  hasScanResult,
  activeWorktreePath,
  activeProjectKey,
  scope,
  executionHostScope,
  hostScopeOptions,
  agents,
  group,
  hideEmptySessions,
  sessionLimit,
  adjustmentCount,
  focusSearchRequestId = 0,
  onQueryChange,
  onScopeChange,
  onExecutionHostScopeChange,
  onAgentEnabledChange,
  onAllAgentsEnabledChange,
  onGroupChange,
  onHideEmptySessionsChange,
  onSessionLimitChange,
  onReset,
  onRefresh
}: AiVaultPanelHeaderProps): React.JSX.Element {
  const searchInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (focusSearchRequestId > 0) {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }
  }, [focusSearchRequestId])
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
            {searching || hasScanResult
              ? translate('sessionSearch.panel.indexedHistory', 'Indexed history')
              : translate(
                  'auto.components.right.sidebar.AiVaultPanel.resumePastSessions',
                  'Resume past sessions'
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
            searching={searching}
            agents={agents}
            group={group}
            hideEmptySessions={hideEmptySessions}
            sessionLimit={sessionLimit}
            adjustmentCount={adjustmentCount}
            onAgentEnabledChange={onAgentEnabledChange}
            onAllAgentsEnabledChange={onAllAgentsEnabledChange}
            onGroupChange={onGroupChange}
            onHideEmptySessionsChange={onHideEmptySessionsChange}
            onSessionLimitChange={onSessionLimitChange}
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

      <div className="mt-2 flex h-8 items-center gap-1.5 rounded-md border border-sidebar-border bg-input/50 px-2 focus-within:border-sidebar-ring focus-within:ring-[2px] focus-within:ring-sidebar-ring/30">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={searchInputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={translate(
            'auto.components.right.sidebar.AiVaultPanel.searchSessions',
            'Search sessions'
          )}
          className="min-w-0 flex-1 bg-transparent py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/50"
          aria-label={translate(
            'auto.components.right.sidebar.AiVaultPanel.searchSessions',
            'Search sessions'
          )}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              onQueryChange('')
            }
          }}
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
