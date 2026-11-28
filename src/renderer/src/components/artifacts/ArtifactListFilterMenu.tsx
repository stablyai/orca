import { Button } from '@/components/ui/button'
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
import { RailPageFilterButton } from '@/components/rail-page/RailPageToolbar'
import { RailPageFilterPill } from '@/components/rail-page/RailPageFilterPill'
import { RAIL_PAGE_HIDE_NARROW } from '@/components/rail-page/RailPageHeader'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  countArtifactListFilters,
  EMPTY_ARTIFACT_LIST_FILTER,
  type ArtifactListExpiresFilter,
  type ArtifactListFilter,
  type ArtifactListUpdatedFilter,
  type ArtifactTypeOption
} from './artifact-list-view'

function updatedOptions(
  t: Translate
): readonly { value: ArtifactListUpdatedFilter; label: string }[] {
  return [
    { value: 'any', label: t('auto.components.artifacts.ArtifactListFilterMenu.any', 'Any time') },
    { value: 'today', label: t('auto.components.artifacts.ArtifactListFilterMenu.today', 'Today') },
    {
      value: 'week',
      label: t('auto.components.artifacts.ArtifactListFilterMenu.pastWeek', 'Past 7 days')
    },
    {
      value: 'month',
      label: t('auto.components.artifacts.ArtifactListFilterMenu.pastMonth', 'Past 30 days')
    }
  ]
}

function expiresOptions(
  t: Translate
): readonly { value: ArtifactListExpiresFilter; label: string }[] {
  return [
    { value: 'any', label: t('auto.components.artifacts.ArtifactListFilterMenu.anyExpiry', 'Any') },
    {
      value: 'week',
      label: t('auto.components.artifacts.ArtifactListFilterMenu.withinWeek', 'Within 7 days')
    },
    {
      value: 'expired',
      label: t('auto.components.artifacts.ArtifactListFilterMenu.expired', 'Expired')
    }
  ]
}

function typeLabel(t: Translate): string {
  return t('auto.components.artifacts.ArtifactListTableHeader.type', 'Type')
}
function updatedLabel(t: Translate): string {
  return t('auto.components.artifacts.ArtifactListTableHeader.updated', 'Updated')
}
function expiresLabel(t: Translate): string {
  return t('auto.components.artifacts.ArtifactListTableHeader.expires', 'Expires')
}

export function ArtifactListFilterMenu({
  filter,
  typeOptions,
  onChange
}: {
  filter: ArtifactListFilter
  /** Types present in the loaded list, with counts. */
  typeOptions: readonly ArtifactTypeOption[]
  onChange: (next: ArtifactListFilter) => void
}): React.JSX.Element {
  const t = useTranslate()
  const activeCount = countArtifactListFilters(filter)
  // A selected type stays listed after its last artifact is deleted, so it can still be unchecked.
  const listedTypes = [
    ...typeOptions,
    ...filter.types
      .filter((type) => !typeOptions.some((option) => option.type === type))
      .map((type) => ({ type, label: type, count: 0 }))
  ]
  const toggleType = (type: string): void => {
    const types = filter.types.includes(type)
      ? filter.types.filter((selected) => selected !== type)
      : [...filter.types, type]
    onChange({ ...filter, types })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <RailPageFilterButton activeCount={activeCount} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{typeLabel(t)}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-80 overflow-y-auto scrollbar-sleek">
            {listedTypes.map((option) => (
              <DropdownMenuCheckboxItem
                key={option.type}
                checked={filter.types.includes(option.type)}
                onCheckedChange={() => toggleType(option.type)}
                onSelect={(event) => event.preventDefault()}
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                  {option.count}
                </span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{updatedLabel(t)}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={filter.updated}
              onValueChange={(value) =>
                onChange({ ...filter, updated: value as ArtifactListUpdatedFilter })
              }
            >
              {updatedOptions(t).map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{expiresLabel(t)}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={filter.expires}
              onValueChange={(value) =>
                onChange({ ...filter, expires: value as ArtifactListExpiresFilter })
              }
            >
              {expiresOptions(t).map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {activeCount > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange(EMPTY_ARTIFACT_LIST_FILTER)}>
              {t('auto.components.artifacts.ArtifactListFilterMenu.clearFilters', 'Clear filters')}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Active filters after the Filter button; hidden when narrow, where the button's count stands in. */
export function ArtifactListFilterPills({
  filter,
  typeOptions,
  onChange
}: {
  filter: ArtifactListFilter
  typeOptions: readonly ArtifactTypeOption[]
  onChange: (next: ArtifactListFilter) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  if (countArtifactListFilters(filter) === 0) {
    return null
  }
  const typeValue = filter.types
    .map((type) => typeOptions.find((option) => option.type === type)?.label ?? type)
    .join(', ')
  const updatedValue = updatedOptions(t).find((option) => option.value === filter.updated)?.label
  const expiresValue = expiresOptions(t).find((option) => option.value === filter.expires)?.label
  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', RAIL_PAGE_HIDE_NARROW)}>
      {filter.types.length > 0 ? (
        <RailPageFilterPill
          label={typeLabel(t)}
          value={typeValue}
          onClear={() => onChange({ ...filter, types: [] })}
        />
      ) : null}
      {filter.updated !== 'any' && updatedValue ? (
        <RailPageFilterPill
          label={updatedLabel(t)}
          value={updatedValue}
          onClear={() => onChange({ ...filter, updated: 'any' })}
        />
      ) : null}
      {filter.expires !== 'any' && expiresValue ? (
        <RailPageFilterPill
          label={expiresLabel(t)}
          value={expiresValue}
          onClear={() => onChange({ ...filter, expires: 'any' })}
        />
      ) : null}
      <Button
        type="button"
        variant="ghost-muted"
        size="toolbar"
        onClick={() => onChange(EMPTY_ARTIFACT_LIST_FILTER)}
      >
        {t('auto.components.artifacts.ArtifactListFilterMenu.clear', 'Clear')}
      </Button>
    </div>
  )
}
