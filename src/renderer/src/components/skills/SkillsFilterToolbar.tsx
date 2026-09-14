import { RefreshCw, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { SkillSourceKind } from '../../../../shared/skills'
import { resultCountLabel, shareLinkCountLabel, sourceKindLabel } from './skill-display-labels'
import { SKILLS_PAGE_COLUMN } from './skills-page-column'
import type { SkillsFilterState } from './skills-filter'
import type { SkillsPageView } from './skills-page-view'
import type { SkillAgentOption } from './skill-agent-filter'

const SOURCE_KINDS: SkillSourceKind[] = ['home', 'repo', 'bundled', 'plugin']

export function SkillsFilterToolbar({
  view,
  filters,
  agentOptions,
  sourceCounts,
  totalCount,
  resultCount,
  linkCount,
  loading,
  onViewChange,
  onFiltersChange,
  onRefresh
}: {
  view: SkillsPageView
  filters: SkillsFilterState
  agentOptions: readonly SkillAgentOption[]
  sourceCounts: Record<SkillSourceKind, number>
  totalCount: number
  resultCount: number
  linkCount: number
  loading: boolean
  onViewChange: (next: SkillsPageView) => void
  onFiltersChange: (next: SkillsFilterState) => void
  onRefresh: () => void
}): React.JSX.Element {
  const sharedView = view === 'shared'
  const filtered =
    filters.query.trim() !== '' || filters.sourceKind !== 'all' || filters.agent !== 'all'
  return (
    <section className="shrink-0 border-b border-border">
      <div className={cn(SKILLS_PAGE_COLUMN, 'flex flex-col gap-2 py-3')}>
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filters.query}
              onChange={(event) => onFiltersChange({ ...filters, query: event.target.value })}
              placeholder={
                sharedView
                  ? translate('auto.components.skills.SkillsPage.searchLinks', 'Search links')
                  : translate('auto.components.skills.SkillsPage.a68dee6a32', 'Search skills')
              }
              aria-label={
                sharedView
                  ? translate('auto.components.skills.SkillsPage.searchLinks', 'Search links')
                  : translate('auto.components.skills.SkillsPage.a68dee6a32', 'Search skills')
              }
              className="h-8 pl-8 text-sm"
            />
          </div>
          {sharedView ? null : (
            <Select
              value={filters.agent}
              onValueChange={(value) => onFiltersChange({ ...filters, agent: value })}
            >
              <SelectTrigger
                className="h-8 w-[170px]"
                aria-label={translate(
                  'auto.components.skills.SkillsPage.filterProvider',
                  'Filter by agent'
                )}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {translate('auto.components.skills.filter.allAgents', 'All agents')}
                </SelectItem>
                {agentOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label} <span className="text-muted-foreground">{option.count}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0 border border-border/50 bg-transparent hover:bg-muted/50"
                disabled={loading}
                onClick={onRefresh}
                aria-label={translate('auto.components.skills.SkillsPage.cb142070b4', 'Refresh')}
              >
                <RefreshCw className={loading ? 'animate-spin' : undefined} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.skills.SkillsPage.cb142070b4', 'Refresh')}
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {/* Why: the view switch shares the chips' pill shape so the row reads
              as one control strip; the rule marks where filtering starts. */}
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={1}
            value={view}
            onValueChange={(value) => onViewChange((value || 'skills') as SkillsPageView)}
            aria-label={translate('auto.components.skills.SkillsPage.viewSwitch', 'Show')}
          >
            <ToggleGroupItem value="skills" className="rounded-full px-2.5 text-xs">
              {translate('auto.components.skills.SkillsPage.f43ad6edf3', 'Skills')}
            </ToggleGroupItem>
            <ToggleGroupItem value="shared" className="rounded-full px-2.5 text-xs">
              {translate('auto.components.skills.SkillsPage.sharedLinks', 'Shared links')}
            </ToggleGroupItem>
          </ToggleGroup>
          {sharedView ? null : (
            <>
              <div className="h-4 w-px shrink-0 bg-border" aria-hidden />
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                spacing={1}
                value={filters.sourceKind}
                // Why: Radix reports '' when the active item is pressed again; the
                // list must always have a source filter, so re-press falls back to all.
                onValueChange={(value) =>
                  onFiltersChange({
                    ...filters,
                    sourceKind: (value || 'all') as SkillsFilterState['sourceKind']
                  })
                }
                aria-label={translate(
                  'auto.components.skills.SkillsPage.filterSource',
                  'Filter by source'
                )}
              >
                <ToggleGroupItem value="all" className="gap-1.5 rounded-full px-2.5 text-xs">
                  {translate('auto.components.skills.SkillsPage.allSources', 'All')}
                  <span className="tabular-nums text-muted-foreground">{totalCount}</span>
                </ToggleGroupItem>
                {SOURCE_KINDS.map((sourceKind) => (
                  <ToggleGroupItem
                    key={sourceKind}
                    value={sourceKind}
                    className="gap-1.5 rounded-full px-2.5 text-xs"
                  >
                    {sourceKindLabel(sourceKind)}
                    <span className="tabular-nums text-muted-foreground">
                      {sourceCounts[sourceKind]}
                    </span>
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                <span role="status" aria-live="polite">
                  {resultCountLabel(resultCount)}
                </span>
                {filtered ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() =>
                      onFiltersChange({
                        query: '',
                        sourceKind: 'all',
                        agent: 'all'
                      })
                    }
                  >
                    {translate('auto.components.skills.SkillsPage.clearFilters', 'Clear filters')}
                  </Button>
                ) : null}
              </div>
            </>
          )}
          {sharedView ? (
            <span
              className="ml-auto text-xs text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              {shareLinkCountLabel(linkCount)}
            </span>
          ) : null}
        </div>
      </div>
    </section>
  )
}
