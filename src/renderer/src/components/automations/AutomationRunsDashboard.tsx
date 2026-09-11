import React, { useDeferredValue, useMemo, useState } from 'react'
import { AlertCircle, ListFilter, RefreshCw, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { AutomationListRow } from './automation-list-row-identity'
import {
  countAutomationRunOutcomes,
  filterAutomationRunsDashboardEntries,
  getAutomationRunsHostKey,
  getAutomationRunsScope,
  type AutomationRunsDashboardEntry,
  type AutomationRunsDashboardFailure,
  type AutomationRunsStatusFilter
} from './automation-runs-dashboard-model'
import { AutomationRunsTable } from './AutomationRunsTable'

const STATUS_LABELS: Record<AutomationRunsStatusFilter, { key: string; fallback: string }> = {
  all: { key: 'allStatuses', fallback: 'All statuses' },
  successful: { key: 'successful', fallback: 'Successful' },
  failed: { key: 'failed', fallback: 'Failed' },
  active: { key: 'active', fallback: 'In progress' },
  skipped: { key: 'skipped', fallback: 'Skipped' }
}

function SummaryCard({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border/60 bg-card px-3 py-2.5 text-card-foreground">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-medium tabular-nums">{value}</div>
    </div>
  )
}

export function AutomationRunsDashboard({
  rows,
  entries,
  failures,
  loading,
  hasMore,
  onLoadMore,
  now,
  onRefresh,
  onOpenRun
}: {
  rows: readonly AutomationListRow[]
  entries: readonly AutomationRunsDashboardEntry[]
  failures: readonly AutomationRunsDashboardFailure[]
  loading: boolean
  hasMore: boolean
  onLoadMore: () => void
  now: number
  onRefresh: () => void
  onOpenRun: (entry: AutomationRunsDashboardEntry) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [status, setStatus] = useState<AutomationRunsStatusFilter>('all')
  const [hostKeys, setHostKeys] = useState<string[]>([])
  const hostOptions = useMemo(() => {
    const options = new Map<string, string>()
    for (const row of rows) {
      const scope = getAutomationRunsScope(row)
      options.set(
        getAutomationRunsHostKey(row),
        row.hostLabel ||
          translate(
            `auto.components.automations.AutomationRunsDashboard.${scope}`,
            scope === 'local' ? 'Local' : 'Remote'
          )
      )
    }
    return [...options].map(([key, label]) => ({ key, label }))
  }, [rows])
  const hostEntries = useMemo(
    () => filterAutomationRunsDashboardEntries({ entries, status: 'all', query: '', hostKeys }),
    [entries, hostKeys]
  )
  const visibleEntries = useMemo(
    () => filterAutomationRunsDashboardEntries({ entries, status, query: deferredQuery, hostKeys }),
    [deferredQuery, entries, hostKeys, status]
  )
  const counts = useMemo(() => countAutomationRunOutcomes(hostEntries, now), [hostEntries, now])
  const visibleFailures = failures.filter(
    (failure) => hostKeys.length === 0 || hostKeys.includes(getAutomationRunsHostKey(failure.row))
  )
  const activeFilterCount = (status === 'all' ? 0 : 1) + (hostKeys.length > 0 ? 1 : 0)

  const toggleHost = (hostKey: string): void => {
    setHostKeys((current) =>
      current.includes(hostKey)
        ? current.filter((candidate) => candidate !== hostKey)
        : [...current, hostKey]
    )
  }

  return (
    <div className="scrollbar-sleek min-h-0 flex-1 overflow-auto px-3 pb-4 md:px-5">
      <div className="w-full">
        <div className="mb-3 flex shrink-0 items-end gap-2">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={translate(
                'auto.components.automations.AutomationRunsDashboard.search',
                'Search runs…'
              )}
              aria-label={translate(
                'auto.components.automations.AutomationRunsDashboard.search',
                'Search runs…'
              )}
              className="h-8 pl-8 text-xs"
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="h-8 text-xs">
                <ListFilter className="size-3.5" />
                {translate(
                  'auto.components.automations.AutomationRunsDashboard.filters',
                  'Filters'
                )}
                {activeFilterCount > 0 ? (
                  <span className="rounded-full bg-foreground px-1.5 text-[10px] font-semibold leading-4 text-background">
                    {activeFilterCount}
                  </span>
                ) : null}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  {translate('auto.components.automations.AutomationRunsDashboard.host', 'Host')}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="scrollbar-sleek max-h-80 overflow-y-auto">
                  <DropdownMenuCheckboxItem
                    checked={hostKeys.length === 0}
                    onCheckedChange={() => setHostKeys([])}
                  >
                    {translate('auto.components.automations.hostPicker.allHosts', 'All hosts')}
                  </DropdownMenuCheckboxItem>
                  {hostOptions.map((host) => (
                    <DropdownMenuCheckboxItem
                      key={host.key}
                      checked={hostKeys.includes(host.key)}
                      onCheckedChange={() => toggleHost(host.key)}
                      onSelect={(event) => event.preventDefault()}
                    >
                      {host.label}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  {translate(
                    'auto.components.automations.AutomationRunsDashboard.status',
                    'Status'
                  )}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup
                    value={status}
                    onValueChange={(value) => setStatus(value as AutomationRunsStatusFilter)}
                  >
                    {Object.entries(STATUS_LABELS).map(([value, label]) => (
                      <DropdownMenuRadioItem key={value} value={value}>
                        {translate(
                          `auto.components.automations.AutomationRunsDashboard.status.${label.key}`,
                          label.fallback
                        )}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={translate(
                  'auto.components.automations.AutomationRunsDashboard.refresh',
                  'Refresh runs'
                )}
                onClick={onRefresh}
                disabled={loading}
                className="shrink-0 border border-border bg-background shadow-none hover:bg-muted/50"
              >
                <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate(
                'auto.components.automations.AutomationRunsDashboard.refresh',
                'Refresh runs'
              )}
            </TooltipContent>
          </Tooltip>
        </div>

        <div>
          <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
            <SummaryCard
              label={translate(
                'auto.components.automations.AutomationRunsDashboard.successful24h',
                'Successful · 24h'
              )}
              value={counts.successful24h}
            />
            <SummaryCard
              label={translate(
                'auto.components.automations.AutomationRunsDashboard.failed24h',
                'Failed · 24h'
              )}
              value={counts.failed24h}
            />
            <SummaryCard
              label={translate(
                'auto.components.automations.AutomationRunsDashboard.successful7d',
                'Successful · 7d'
              )}
              value={counts.successful7d}
            />
            <SummaryCard
              label={translate(
                'auto.components.automations.AutomationRunsDashboard.failed7d',
                'Failed · 7d'
              )}
              value={counts.failed7d}
            />
          </div>

          {visibleFailures.length > 0 ? (
            <div className="mb-3 flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-foreground">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span>
                {visibleFailures.length === 1
                  ? translate(
                      'auto.components.automations.AutomationRunsDashboard.historyUnavailableOne',
                      'Run history is unavailable for 1 automation. Counts include available history only.'
                    )
                  : translate(
                      'auto.components.automations.AutomationRunsDashboard.historyUnavailableMany',
                      'Run history is unavailable for {{count}} automations. Counts include available history only.',
                      { count: visibleFailures.length }
                    )}
              </span>
            </div>
          ) : null}

          <AutomationRunsTable
            entries={visibleEntries}
            loading={loading}
            hasMore={hasMore}
            onLoadMore={onLoadMore}
            onOpenRun={onOpenRun}
          />
        </div>
      </div>
    </div>
  )
}
