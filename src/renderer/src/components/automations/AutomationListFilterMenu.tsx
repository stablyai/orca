import React from 'react'
import { ListFilter, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { AgentIcon, getAgentCatalog } from '@/lib/agent-catalog'
import { searchAgentPickerEntries } from '@/lib/agent-picker-search'
import { translate } from '@/i18n/i18n'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import {
  countAutomationListFilters,
  EMPTY_AUTOMATION_LIST_FILTER,
  type AutomationListFilter,
  type AutomationListLastRunFilter,
  type AutomationListStatusFilter
} from './automation-list-view'

function FilterPill({
  label,
  value,
  onClear
}: {
  label: string
  value: string
  onClear: () => void
}): React.JSX.Element {
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-full border border-border/60 bg-muted/50 pl-2 pr-1 text-[11px] text-foreground">
      <span className="text-muted-foreground">{label}:</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="max-w-[140px] truncate font-medium">{value}</span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6} className="max-w-72 break-words">
          {value}
        </TooltipContent>
      </Tooltip>
      <button
        type="button"
        aria-label={translate(
          'auto.components.automations.AutomationListFilterMenu.removeFilter',
          'Remove {{value0}} filter',
          { value0: label }
        )}
        onClick={onClear}
        className="rounded-full p-0.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

export function AutomationListFilterPills({
  filter,
  onChange,
  hostLabel,
  onClearHost
}: {
  filter: AutomationListFilter
  onChange: (next: AutomationListFilter) => void
  /** Label of the selected host filter, when one is active and clearable here. */
  hostLabel?: string | null
  onClearHost?: () => void
}): React.JSX.Element | null {
  const statusLabel = translate('auto.components.automations.AutomationsPage.tableStatus', 'Status')
  const lastRunLabel = translate(
    'auto.components.automations.AutomationListFilterMenu.lastRun',
    'Last run'
  )
  const statusValueLabel =
    filter.status === 'enabled'
      ? translate('auto.components.automations.AutomationDetail.eaa02014f8', 'Enabled')
      : filter.status === 'paused'
        ? translate('auto.components.automations.AutomationDetail.b09b2384fd', 'Paused')
        : null
  const lastRunValueLabel =
    filter.lastRun === 'failed'
      ? translate('auto.components.automations.AutomationListFilterMenu.failed', 'Failed')
      : filter.lastRun === 'succeeded'
        ? translate('auto.components.automations.AutomationListFilterMenu.succeeded', 'Succeeded')
        : filter.lastRun === 'never'
          ? translate('auto.components.automations.AutomationListFilterMenu.neverRan', 'Never ran')
          : null
  const agentValueLabel = filter.agentIds.length
    ? filter.agentIds
        .map((agentId) => getAgentCatalog().find((agent) => agent.id === agentId)?.label ?? agentId)
        .join(', ')
    : null
  const hostPillLabel = onClearHost ? (hostLabel ?? null) : null
  if (!statusValueLabel && !lastRunValueLabel && !agentValueLabel && !hostPillLabel) {
    return null
  }
  return (
    <>
      {hostPillLabel && onClearHost ? (
        <FilterPill
          label={translate('auto.components.automations.AutomationsPage.tableHost', 'Host')}
          value={hostPillLabel}
          onClear={onClearHost}
        />
      ) : null}
      {statusValueLabel ? (
        <FilterPill
          label={statusLabel}
          value={statusValueLabel}
          onClear={() => onChange({ ...filter, status: 'all' })}
        />
      ) : null}
      {lastRunValueLabel ? (
        <FilterPill
          label={lastRunLabel}
          value={lastRunValueLabel}
          onClear={() => onChange({ ...filter, lastRun: 'all' })}
        />
      ) : null}
      {agentValueLabel ? (
        <FilterPill
          label={translate('auto.components.automations.AutomationListFilterMenu.agent', 'Agent')}
          value={agentValueLabel}
          onClear={() => onChange({ ...filter, agentIds: [] })}
        />
      ) : null}
    </>
  )
}

export function AutomationListFilterMenu({
  filter,
  onChange,
  hostEntries
}: {
  filter: AutomationListFilter
  onChange: (next: AutomationListFilter) => void
  /** Reuses the host catalog so this menu can never disagree with the row data. */
  hostEntries?: readonly AutomationHostCatalogEntry[]
}): React.JSX.Element {
  const activeCount = countAutomationListFilters(filter)
  const selectedHostKeys = filter.hostStableKeys ?? []

  const toggleHost = (stableKey: string): void => {
    const nextHostKeys = selectedHostKeys.includes(stableKey)
      ? selectedHostKeys.filter((selectedKey) => selectedKey !== stableKey)
      : [...selectedHostKeys, stableKey]
    onChange({ ...filter, hostStableKeys: nextHostKeys })
  }
  const statusLabel = translate('auto.components.automations.AutomationsPage.tableStatus', 'Status')
  const lastRunLabel = translate(
    'auto.components.automations.AutomationListFilterMenu.lastRun',
    'Last run'
  )
  const agentLabel = translate(
    'auto.components.automations.AutomationListFilterMenu.agent',
    'Agent'
  )
  const agents = getAgentCatalog()
  const selectedAgentIds = filter.agentIds
  const [agentQuery, setAgentQuery] = React.useState('')
  const filteredAgents = searchAgentPickerEntries(agents, agentQuery)

  const toggleAgent = (agentId: (typeof agents)[number]['id']): void => {
    const nextAgentIds = selectedAgentIds.includes(agentId)
      ? selectedAgentIds.filter((selectedId) => selectedId !== agentId)
      : [...selectedAgentIds, agentId]
    onChange({ ...filter, agentIds: nextAgentIds })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 shrink-0 gap-1.5 border border-border bg-background px-2.5 text-xs shadow-none hover:bg-muted/50 focus-visible:border-ring/70 focus-visible:ring-0"
        >
          <ListFilter className="size-3.5" />
          {translate('auto.components.automations.AutomationListFilterMenu.filters', 'Filters')}
          {activeCount > 0 ? (
            <span className="rounded-full bg-foreground px-1.5 text-[10px] font-semibold leading-4 text-background">
              {activeCount}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        {hostEntries ? (
          <>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                {translate('auto.components.automations.AutomationsPage.tableHost', 'Host')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 overflow-y-auto scrollbar-sleek">
                <DropdownMenuCheckboxItem
                  checked={selectedHostKeys.length === 0}
                  onCheckedChange={() => onChange({ ...filter, hostStableKeys: [] })}
                  onSelect={(event) => event.preventDefault()}
                >
                  {translate('auto.components.automations.hostPicker.allHosts', 'All hosts')}
                </DropdownMenuCheckboxItem>
                {hostEntries.map((entry) => (
                  <DropdownMenuCheckboxItem
                    key={entry.stableKey}
                    checked={selectedHostKeys.includes(entry.stableKey)}
                    onCheckedChange={() => toggleHost(entry.stableKey)}
                    onSelect={(event) => event.preventDefault()}
                  >
                    {entry.label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{statusLabel}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={filter.status}
              onValueChange={(value) =>
                onChange({ ...filter, status: value as AutomationListStatusFilter })
              }
            >
              <DropdownMenuRadioItem value="all">
                {translate('auto.components.automations.AutomationListFilterMenu.all', 'All')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="enabled">
                {translate('auto.components.automations.AutomationDetail.eaa02014f8', 'Enabled')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="paused">
                {translate('auto.components.automations.AutomationDetail.b09b2384fd', 'Paused')}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{lastRunLabel}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={filter.lastRun}
              onValueChange={(value) =>
                onChange({ ...filter, lastRun: value as AutomationListLastRunFilter })
              }
            >
              <DropdownMenuRadioItem value="all">
                {translate('auto.components.automations.AutomationListFilterMenu.all', 'All')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="failed">
                {translate('auto.components.automations.AutomationListFilterMenu.failed', 'Failed')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="succeeded">
                {translate(
                  'auto.components.automations.AutomationListFilterMenu.succeeded',
                  'Succeeded'
                )}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="never">
                {translate(
                  'auto.components.automations.AutomationListFilterMenu.neverRan',
                  'Never ran'
                )}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{agentLabel}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-80 overflow-y-auto scrollbar-sleek">
            <div className="p-1">
              <Input
                value={agentQuery}
                onChange={(event) => setAgentQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape' && event.key !== 'Tab') {
                    event.stopPropagation()
                  }
                }}
                onPointerDown={(event) => event.stopPropagation()}
                placeholder={translate(
                  'auto.components.automations.AutomationListFilterMenu.926e785e4d',
                  'Search agents...'
                )}
                aria-label={translate(
                  'auto.components.automations.AutomationListFilterMenu.926e785e4d',
                  'Search agents...'
                )}
                className="h-7 px-2 text-xs"
              />
            </div>
            <DropdownMenuCheckboxItem
              checked={selectedAgentIds.length === 0}
              onCheckedChange={() => onChange({ ...filter, agentIds: [] })}
              onSelect={(event) => event.preventDefault()}
            >
              {translate('auto.components.automations.AutomationListFilterMenu.all', 'All')}
            </DropdownMenuCheckboxItem>
            {filteredAgents.map((agent) => (
              <DropdownMenuCheckboxItem
                key={agent.id}
                checked={selectedAgentIds.includes(agent.id)}
                onCheckedChange={() => toggleAgent(agent.id)}
                onSelect={(event) => event.preventDefault()}
              >
                <span className="inline-flex size-3.5 shrink-0 items-center justify-center [&_img]:size-3.5 [&_svg]:size-3.5!">
                  <AgentIcon agent={agent.id} size={14} />
                </span>
                {agent.label}
              </DropdownMenuCheckboxItem>
            ))}
            {filteredAgents.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                {translate(
                  'auto.components.automations.AutomationListFilterMenu.491043ee45',
                  'No agents match your search.'
                )}
              </div>
            ) : null}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {activeCount > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange(EMPTY_AUTOMATION_LIST_FILTER)}>
              {translate(
                'auto.components.automations.AutomationListFilterMenu.clear',
                'Clear filters'
              )}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
