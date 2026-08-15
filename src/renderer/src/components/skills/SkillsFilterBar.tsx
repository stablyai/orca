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
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { SkillSourceKind } from '../../../../shared/skills'
import { getSkillSourceLabel } from './DiscoveredSkillCard'
import type { SkillsFilterState } from './skills-filter'

const SOURCE_KIND_OPTIONS: readonly SkillSourceKind[] = ['home', 'repo', 'bundled', 'plugin']

type SkillsFilterBarProps = {
  filters: SkillsFilterState
  sourceCounts: Record<SkillSourceKind, number>
  loading: boolean
  onFiltersChange: (filters: SkillsFilterState) => void
  onRefresh: () => void
}

export function SkillsFilterBar({
  filters,
  sourceCounts,
  loading,
  onFiltersChange,
  onRefresh
}: SkillsFilterBarProps): React.JSX.Element {
  const totalCount = SOURCE_KIND_OPTIONS.reduce(
    (count, sourceKind) => count + sourceCounts[sourceKind],
    0
  )

  return (
    <section className="flex shrink-0 flex-col gap-3 border-b border-border px-5 py-4">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filters.query}
            onChange={(event) => onFiltersChange({ ...filters, query: event.target.value })}
            placeholder={translate('auto.components.skills.SkillsPage.a68dee6a32', 'Search skills')}
            className="h-8 pl-8 text-sm"
          />
        </div>
        <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center">
          <SkillsSourceFilterChips
            value={filters.sourceKind}
            sourceCounts={sourceCounts}
            totalCount={totalCount}
            onValueChange={(sourceKind) => onFiltersChange({ ...filters, sourceKind })}
          />
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Select
              value={filters.provider}
              onValueChange={(value) =>
                onFiltersChange({
                  ...filters,
                  provider: value as SkillsFilterState['provider']
                })
              }
            >
              <SelectTrigger className="h-8 w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {translate('auto.components.skills.SkillsPage.39b6998ddb', 'All providers')}
                </SelectItem>
                <SelectItem value="codex">
                  {translate('auto.components.skills.SkillsPage.426be2aac6', 'Codex')}
                </SelectItem>
                <SelectItem value="claude">
                  {translate('auto.components.skills.SkillsPage.fb6bf60b52', 'Claude')}
                </SelectItem>
                <SelectItem value="agent-skills">
                  {translate('auto.components.skills.SkillsPage.38e0951c3a', 'Agent Skills')}
                </SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={filters.sourceKind}
              onValueChange={(value) =>
                onFiltersChange({
                  ...filters,
                  sourceKind: value as SkillsFilterState['sourceKind']
                })
              }
            >
              <SelectTrigger className="h-8 w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {translate('auto.components.skills.SkillsPage.0bc1379f4c', 'All sources')}
                </SelectItem>
                {SOURCE_KIND_OPTIONS.map((sourceKind) => (
                  <SelectItem key={sourceKind} value={sourceKind}>
                    {getSkillSourceLabel(sourceKind)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              disabled={loading}
              onClick={onRefresh}
            >
              <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
              {translate('auto.components.skills.SkillsPage.cb142070b4', 'Refresh')}
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}

export function SkillsSourceFilterChips({
  value,
  sourceCounts,
  totalCount,
  onValueChange
}: {
  value: SkillsFilterState['sourceKind']
  sourceCounts: Record<SkillSourceKind, number>
  totalCount: number
  onValueChange: (sourceKind: SkillsFilterState['sourceKind']) => void
}): React.JSX.Element {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(nextValue) => {
        if (nextValue) {
          onValueChange(nextValue as SkillsFilterState['sourceKind'])
        }
      }}
      variant="outline"
      size="sm"
      className="max-w-full flex-wrap"
      aria-label={translate('auto.components.skills.SkillsPage.42884b773d', 'Filter by source')}
    >
      <ToggleGroupItem
        value="all"
        aria-label={translate('auto.components.skills.SkillsPage.0bc1379f4c', 'All sources')}
      >
        <span>{translate('auto.components.skills.SkillsPage.0bc1379f4c', 'All sources')}</span>
        <span className="rounded-full bg-muted px-1.5 py-0 text-[11px] text-muted-foreground">
          {totalCount}
        </span>
      </ToggleGroupItem>
      {SOURCE_KIND_OPTIONS.map((sourceKind) => (
        <ToggleGroupItem
          key={sourceKind}
          value={sourceKind}
          aria-label={`${getSkillSourceLabel(sourceKind)} ${sourceCounts[sourceKind]}`}
        >
          <span>{getSkillSourceLabel(sourceKind)}</span>
          <span className="rounded-full bg-muted px-1.5 py-0 text-[11px] text-muted-foreground">
            {sourceCounts[sourceKind]}
          </span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
