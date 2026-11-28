import React, { useDeferredValue, useMemo, useRef, useState } from 'react'
import { AlertCircle, Search } from 'lucide-react'
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
import { RailPageBody, RailPageNotice, RAIL_PAGE_GUTTER_X } from '@/components/rail-page/RailPage'
import { RailPageSearch } from '@/components/rail-page/RailPageSearch'
import { RailPageFilterButton, RailPageToolbar } from '@/components/rail-page/RailPageToolbar'
import { cn } from '@/lib/class-names'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import type { AutomationListRow } from '../listing/automation-list-row-identity'
import type { Worktree } from '../../../../../shared/worktree/types'
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
  tabs,
  notice,
  rows,
  entries,
  failures,
  loading,
  hasMore,
  onLoadMore,
  now,
  onOpenRun,
  worktreeForRun
}: {
  tabs: React.ReactNode
  notice: React.ReactNode
  rows: readonly AutomationListRow[]
  entries: readonly AutomationRunsDashboardEntry[]
  failures: readonly AutomationRunsDashboardFailure[]
  loading: boolean
  hasMore: boolean
  onLoadMore: () => void
  now: number
  onOpenRun: (entry: AutomationRunsDashboardEntry) => void
  worktreeForRun: (entry: AutomationRunsDashboardEntry) => Worktree | null
}): React.JSX.Element {
  const t = useTranslate()
  const languageRevision = useUiLanguageRevision()
  const inputRef = useRef<HTMLInputElement>(null)
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
          t(
            `auto.components.automations.AutomationRunsDashboard.${scope}`,
            scope === 'local' ? 'Local' : 'Remote'
          )
      )
    }
    return [...options].map(([key, label]) => ({ key, label }))
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- translate() reads the UI language implicitly.
  }, [rows, languageRevision, t])
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
    <>
      <RailPageToolbar
        start={tabs}
        end={
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <RailPageFilterButton activeCount={activeFilterCount} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    {t('auto.components.automations.AutomationRunsDashboard.host', 'Host')}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="scrollbar-sleek max-h-80 overflow-y-auto">
                    <DropdownMenuCheckboxItem
                      checked={hostKeys.length === 0}
                      onCheckedChange={() => setHostKeys([])}
                    >
                      {t('auto.components.automations.hostPicker.allHosts', 'All hosts')}
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
                    {t('auto.components.automations.AutomationRunsDashboard.status', 'Status')}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuRadioGroup
                      value={status}
                      onValueChange={(value) => setStatus(value as AutomationRunsStatusFilter)}
                    >
                      {Object.entries(STATUS_LABELS).map(([value, label]) => (
                        <DropdownMenuRadioItem key={value} value={value}>
                          {t(
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
            <RailPageSearch inputRef={inputRef} hasValue={query !== ''} focusTarget="automations">
              <div className="relative w-full">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={inputRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t(
                    'auto.components.automations.AutomationRunsDashboard.search',
                    'Search runs…'
                  )}
                  aria-label={t(
                    'auto.components.automations.AutomationRunsDashboard.searchLabel',
                    'Search runs'
                  )}
                  data-automations-page-search=""
                  data-rail-page-focus-target=""
                  density="compact"
                  surface="background"
                  inset="leadingIcon"
                  adornment={query === '' ? 'shortcut' : 'none'}
                />
              </div>
            </RailPageSearch>
          </>
        }
      />
      <RailPageNotice>{notice}</RailPageNotice>
      <RailPageBody>
        <div
          className={cn('my-3 grid shrink-0 grid-cols-2 gap-2 md:grid-cols-4', RAIL_PAGE_GUTTER_X)}
        >
          <SummaryCard
            label={t(
              'auto.components.automations.AutomationRunsDashboard.successful24h',
              'Successful · 24h'
            )}
            value={counts.successful24h}
          />
          <SummaryCard
            label={t(
              'auto.components.automations.AutomationRunsDashboard.failed24h',
              'Failed · 24h'
            )}
            value={counts.failed24h}
          />
          <SummaryCard
            label={t(
              'auto.components.automations.AutomationRunsDashboard.successful7d',
              'Successful · 7d'
            )}
            value={counts.successful7d}
          />
          <SummaryCard
            label={t('auto.components.automations.AutomationRunsDashboard.failed7d', 'Failed · 7d')}
            value={counts.failed7d}
          />
        </div>

        {visibleFailures.length > 0 ? (
          <RailPageNotice>
            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-foreground">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span>
                {t(
                  'auto.components.automations.AutomationRunsDashboard.historyUnavailable',
                  'Run history is unavailable for {{count}} automations. Counts include available history only.',
                  {
                    count: visibleFailures.length,
                    defaultValue_one:
                      'Run history is unavailable for {{count}} automation. Counts include available history only.'
                  }
                )}
              </span>
            </div>
          </RailPageNotice>
        ) : null}

        <AutomationRunsTable
          entries={visibleEntries}
          loading={loading}
          hasMore={hasMore}
          onLoadMore={onLoadMore}
          onOpenRun={onOpenRun}
          worktreeForRun={worktreeForRun}
        />
      </RailPageBody>
    </>
  )
}
