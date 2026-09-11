import type React from 'react'
import {
  ArchiveRestore,
  Calendar,
  Clock3,
  FolderOpen,
  ListFilter,
  PanelsTopLeft
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import {
  AI_VAULT_AGENTS,
  AI_VAULT_SESSION_HOSTS,
  type AiVaultAgent,
  type AiVaultGroup,
  type AiVaultSessionHost,
  type AiVaultSort,
  type AiVaultTimeRange
} from '../../../../shared/ai-vault-types'
import {
  AI_VAULT_SEARCH_SCOPES,
  type AiVaultSearchScope
} from '../../../../shared/ai-vault-session-search-scope'
import { agentLabel } from './ai-vault-session-filters'
import { aiVaultSearchScopeLabel } from './AiVaultSearchScopeControl'
import { translate } from '@/i18n/i18n'
import { AiVaultSessionLimitMenu } from './AiVaultSessionLimitMenu'
import type { AiVaultSessionLimit } from './ai-vault-session-limit'

const VAULT_HEADER_CONTROL_CLASS = 'size-6 shrink-0'

const AGENT_BULK_ACTION_CLASS =
  'rounded-full px-2 py-0.5 text-[11px] font-normal text-muted-foreground focus:text-foreground'

export function VaultViewMenu({
  agents,
  sort,
  group,
  hideEmptySessions,
  sessionLimit,
  timeRange,
  hosts,
  searchScope,
  adjustmentCount,
  onAgentEnabledChange,
  onAllAgentsEnabledChange,
  onSortChange,
  onGroupChange,
  onHideEmptySessionsChange,
  onSessionLimitChange,
  onTimeRangeChange,
  onHostEnabledChange,
  onSearchScopeChange,
  onReset
}: {
  agents: readonly AiVaultAgent[]
  sort: AiVaultSort
  group: AiVaultGroup
  hideEmptySessions: boolean
  sessionLimit: AiVaultSessionLimit
  timeRange: AiVaultTimeRange
  hosts: readonly AiVaultSessionHost[]
  searchScope: AiVaultSearchScope
  adjustmentCount: number
  onAgentEnabledChange: (agent: AiVaultAgent, enabled: boolean) => void
  onAllAgentsEnabledChange: (enabled: boolean) => void
  onSortChange: (sort: AiVaultSort) => void
  onGroupChange: (group: AiVaultGroup) => void
  onHideEmptySessionsChange: (hideEmptySessions: boolean) => void
  onSessionLimitChange: (limit: AiVaultSessionLimit) => void
  onTimeRangeChange: (timeRange: AiVaultTimeRange) => void
  onHostEnabledChange: (host: AiVaultSessionHost, enabled: boolean) => void
  onSearchScopeChange: (searchScope: AiVaultSearchScope) => void
  onReset: () => void
}): React.JSX.Element {
  const allAgentsSelected = agents.length === AI_VAULT_AGENTS.length
  const noAgentsSelected = agents.length === 0

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn(
            VAULT_HEADER_CONTROL_CLASS,
            'relative text-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
          )}
          aria-label={translate(
            'auto.components.right.sidebar.AiVaultPanelControls.viewOptionsAriaLabel',
            'Session History view options'
          )}
        >
          <ListFilter className="size-3" />
          <span className="sr-only">
            {translate(
              'auto.components.right.sidebar.AiVaultPanelControls.viewOptions',
              'View options'
            )}
          </span>
          {adjustmentCount > 0 ? (
            <span
              aria-hidden
              className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-medium leading-none text-primary-foreground"
            >
              {adjustmentCount}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="w-56">
        <DropdownMenuLabel>
          {translate('auto.components.right.sidebar.AiVaultPanelControls.searchIn', 'Search in')}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={searchScope}
          onValueChange={(value) => onSearchScopeChange(value as AiVaultSearchScope)}
        >
          {AI_VAULT_SEARCH_SCOPES.map((scope) => (
            <DropdownMenuRadioItem key={scope} value={scope}>
              {aiVaultSearchScopeLabel(scope)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {/* Why: Select all / Clear lets users isolate one agent without unchecking 15 boxes. */}
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-[11px] font-semibold text-muted-foreground">
            {translate('auto.components.right.sidebar.AiVaultPanelControls.agents', 'Agents')}
          </span>
          {/* Why: real menu items so arrow keys reach them; plain buttons are skipped by Radix roving focus. */}
          <div className="flex items-center gap-1">
            <DropdownMenuItem
              disabled={allAgentsSelected}
              // Why: preventDefault keeps the menu open for further multi-select.
              onSelect={(event) => {
                event.preventDefault()
                onAllAgentsEnabledChange(true)
              }}
              className={AGENT_BULK_ACTION_CLASS}
            >
              {translate(
                'auto.components.right.sidebar.AiVaultPanelControls.selectAllAgents',
                'Select all'
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={noAgentsSelected}
              onSelect={(event) => {
                event.preventDefault()
                onAllAgentsEnabledChange(false)
              }}
              className={AGENT_BULK_ACTION_CLASS}
            >
              {translate('auto.components.right.sidebar.AiVaultPanelControls.clearAgents', 'Clear')}
            </DropdownMenuItem>
          </div>
        </div>
        {AI_VAULT_AGENTS.map((agent) => (
          <DropdownMenuCheckboxItem
            key={agent}
            checked={agents.includes(agent)}
            onCheckedChange={(checked) => onAgentEnabledChange(agent, checked === true)}
            onSelect={(event) => event.preventDefault()}
          >
            <AgentIcon agent={agent} size={14} />
            {agentLabel(agent)}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>
          {translate('auto.components.right.sidebar.AiVaultPanelControls.sort', 'Sort')}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={sort}
          onValueChange={(value) => onSortChange(value as AiVaultSort)}
        >
          <DropdownMenuRadioItem value="updated">
            <Clock3 className="size-3.5" />
            {translate(
              'auto.components.right.sidebar.AiVaultPanelControls.lastUpdated',
              'Last updated'
            )}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="created">
            <Calendar className="size-3.5" />
            {translate('auto.components.right.sidebar.AiVaultPanelControls.created', 'Created')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>
          {translate('auto.components.right.sidebar.AiVaultPanelControls.group', 'Group')}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={group}
          onValueChange={(value) => onGroupChange(value as AiVaultGroup)}
        >
          <DropdownMenuRadioItem value="project">
            <PanelsTopLeft className="size-3.5" />
            {translate('auto.components.right.sidebar.AiVaultPanelControls.project', 'Project')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="folder">
            <FolderOpen className="size-3.5" />
            {translate('auto.components.right.sidebar.AiVaultPanelControls.folder', 'Folder')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="agent">
            <ArchiveRestore className="size-3.5" />
            {translate('auto.components.right.sidebar.AiVaultPanelControls.agent', 'Agent')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>
          {translate('auto.components.right.sidebar.AiVaultPanelControls.updated', 'Updated')}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={timeRange}
          onValueChange={(value) => onTimeRangeChange(value as AiVaultTimeRange)}
        >
          <DropdownMenuRadioItem value="all">
            {translate('auto.components.right.sidebar.AiVaultPanelControls.anyTime', 'Any time')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="24h">
            {translate(
              'auto.components.right.sidebar.AiVaultPanelControls.last24Hours',
              'Last 24 hours'
            )}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="7d">
            {translate(
              'auto.components.right.sidebar.AiVaultPanelControls.last7Days',
              'Last 7 days'
            )}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="30d">
            {translate(
              'auto.components.right.sidebar.AiVaultPanelControls.last30Days',
              'Last 30 days'
            )}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>
          {translate('auto.components.right.sidebar.AiVaultPanelControls.host', 'Host')}
        </DropdownMenuLabel>
        {AI_VAULT_SESSION_HOSTS.map((host) => (
          <DropdownMenuCheckboxItem
            key={host}
            checked={hosts.includes(host)}
            disabled={hosts.length === 1 && hosts.includes(host)}
            onCheckedChange={(checked) => onHostEnabledChange(host, checked === true)}
            onSelect={(event) => event.preventDefault()}
          >
            {host === 'wsl'
              ? translate('auto.components.right.sidebar.AiVaultPanelControls.wslHost', 'WSL')
              : translate('auto.components.right.sidebar.AiVaultPanelControls.localHost', 'Local')}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={hideEmptySessions}
          onCheckedChange={(checked) => onHideEmptySessionsChange(checked === true)}
          onSelect={(event) => event.preventDefault()}
        >
          {translate(
            'auto.components.right.sidebar.AiVaultPanelControls.hideEmptySessions',
            'Hide empty sessions'
          )}
        </DropdownMenuCheckboxItem>
        <AiVaultSessionLimitMenu
          sessionLimit={sessionLimit}
          onSessionLimitChange={onSessionLimitChange}
        />
        {adjustmentCount > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onReset}>
              {translate(
                'auto.components.right.sidebar.AiVaultPanelControls.resetView',
                'Reset view'
              )}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
