import { useRef } from 'react'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { RailPageSearch } from '@/components/rail-page/RailPageSearch'
import {
  RailPageFilterButton,
  RailPageToolbar,
  RailPageViews
} from '@/components/rail-page/RailPageToolbar'
import { useTranslate } from '@/i18n/use-translate'
import type { SkillSourceKind } from '../../../../../shared/skills/discovery/skills'
import {
  resultCountLabel,
  shareLinkCountLabel,
  sourceKindLabel
} from '../presentation/skill-display-labels'
import type { SkillsFilterState } from './skills-filter'
import type { SkillsPageView } from './skills-page-view'
import type { SkillAgentOption } from './skill-agent-filter'

const SOURCE_KINDS: SkillSourceKind[] = ['home', 'repo', 'bundled', 'plugin']
type SkillView = SkillsFilterState['sourceKind'] | 'shared'

export function SkillsFilterToolbar({
  view,
  filters,
  agentOptions,
  sourceCounts,
  totalCount,
  resultCount,
  linkCount,
  linkCountKnown,
  onOpenSharedLinks,
  onSelectSource,
  onFiltersChange
}: {
  view: SkillsPageView
  filters: SkillsFilterState
  agentOptions: readonly SkillAgentOption[]
  sourceCounts: Record<SkillSourceKind, number>
  totalCount: number | null
  resultCount: number
  linkCount: number
  linkCountKnown: boolean
  onOpenSharedLinks: () => void
  onSelectSource: (next: SkillsFilterState['sourceKind']) => void
  onFiltersChange: (next: SkillsFilterState) => void
}): React.JSX.Element {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)
  const sharedView = view === 'shared'
  const agentFiltered = filters.agent !== 'all'
  const showResultCount = filters.query.trim() !== '' || agentFiltered
  const filtered = showResultCount || filters.sourceKind !== 'all'
  const searchLabel = sharedView
    ? t('auto.components.skills.SkillsPage.searchLinks', 'Search links')
    : t('auto.components.skills.SkillsPage.a68dee6a32', 'Search skills')
  return (
    <>
      <RailPageToolbar
        fadeOverflow
        start={
          <RailPageViews<SkillView>
            label={t('auto.components.skills.SkillsPage.viewSwitch', 'Show')}
            hideCountsWhenNarrow
            value={sharedView ? 'shared' : filters.sourceKind}
            onValueChange={(next) =>
              next === 'shared' ? onOpenSharedLinks() : onSelectSource(next)
            }
            items={[
              {
                value: 'all',
                label: t('auto.components.skills.SkillsPage.allSources', 'All'),
                count: totalCount
              },
              ...SOURCE_KINDS.map((kind) => ({
                value: kind,
                label: sourceKindLabel(kind, t),
                count: totalCount === null ? null : sourceCounts[kind]
              })),
              {
                value: 'shared',
                label: t('auto.components.skills.SkillsPage.sharedLinks', 'Shared links'),
                count: linkCountKnown ? linkCount : null,
                separatorBefore: true
              }
            ]}
          />
        }
        end={
          <>
            {!sharedView ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <RailPageFilterButton activeCount={Number(agentFiltered)} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>
                    {t('auto.components.skills.SkillsPage.filterProvider', 'Filter by agent')}
                  </DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={filters.agent}
                    onValueChange={(agent) => onFiltersChange({ ...filters, agent })}
                  >
                    <DropdownMenuRadioItem value="all">
                      {t('auto.components.skills.filter.allAgents', 'All agents')}
                    </DropdownMenuRadioItem>
                    {agentOptions.map((option) => (
                      <DropdownMenuRadioItem key={option.id} value={option.id}>
                        {option.label} <span className="text-muted-foreground">{option.count}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                  {filtered ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() =>
                          onFiltersChange({ query: '', sourceKind: 'all', agent: 'all' })
                        }
                      >
                        {t('auto.components.skills.SkillsPage.clearFilters', 'Clear filters')}
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            <RailPageSearch inputRef={inputRef} hasValue={filters.query !== ''}>
              <div className="relative w-full">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={inputRef}
                  value={filters.query}
                  onChange={(event) => onFiltersChange({ ...filters, query: event.target.value })}
                  placeholder={searchLabel}
                  aria-label={searchLabel}
                  density="compact"
                  surface="background"
                  inset="leadingIcon"
                  adornment={filters.query === '' ? 'shortcut' : 'none'}
                />
              </div>
            </RailPageSearch>
          </>
        }
      />
      <div
        className={
          !sharedView && showResultCount
            ? 'px-(--rail-page-gutter) py-1 text-right text-xs text-muted-foreground'
            : 'sr-only'
        }
        role="status"
        aria-live="polite"
      >
        {sharedView
          ? linkCountKnown
            ? shareLinkCountLabel(linkCount, t)
            : ''
          : resultCountLabel(resultCount, t)}
      </div>
    </>
  )
}
