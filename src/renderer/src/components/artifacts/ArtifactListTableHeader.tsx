import { Checkbox } from '@/components/ui/checkbox'
import { RailPageSortHeader } from '@/components/rail-page/RailPageSortHeader'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import {
  ARTIFACTS_TABLE_GRID_CLASS,
  ARTIFACTS_TABLE_WIDE_ONLY_CLASS
} from './artifacts-table-layout'
import { LIST_TABLE_HEADER_CLASS } from '@/lib/list-interaction/list-table-layout'
import type { ArtifactListSort, ArtifactListSortField } from './artifact-list-view'

const COLUMNS: readonly {
  field: ArtifactListSortField
  key: string
  fallback: string
  wideOnly?: boolean
}[] = [
  {
    field: 'name',
    key: 'auto.components.artifacts.ArtifactListTableHeader.name',
    fallback: 'Name'
  },
  {
    field: 'type',
    key: 'auto.components.artifacts.ArtifactListTableHeader.type',
    fallback: 'Type',
    wideOnly: true
  },
  {
    field: 'size',
    key: 'auto.components.artifacts.ArtifactListTableHeader.size',
    fallback: 'Size',
    wideOnly: true
  },
  {
    field: 'updated',
    key: 'auto.components.artifacts.ArtifactListTableHeader.updated',
    fallback: 'Updated'
  },
  {
    field: 'expires',
    key: 'auto.components.artifacts.ArtifactListTableHeader.expires',
    fallback: 'Expires',
    wideOnly: true
  }
]

export function ArtifactListTableHeader({
  sort,
  onSort,
  selectAllState,
  selecting,
  canSelectAll,
  onToggleAll
}: {
  sort: ArtifactListSort | null
  onSort: (field: ArtifactListSortField) => void
  selectAllState: boolean | 'indeterminate'
  /** Any row is checked, so every checkbox stays shown instead of only on hover. */
  selecting: boolean
  /** False when no row matches, so Select all has nothing to act on. */
  canSelectAll: boolean
  onToggleAll: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      className={cn('group/list-table-header', ARTIFACTS_TABLE_GRID_CLASS, LIST_TABLE_HEADER_CLASS)}
    >
      {COLUMNS.map((column, index) => {
        const sortHeader = (
          <RailPageSortHeader
            field={column.field}
            label={t(column.key, column.fallback)}
            sort={sort}
            onSort={onSort}
          />
        )
        return index === 0 ? (
          // The checkbox takes the rows' type-icon slot, so the Name label lines up with row names.
          <span key={column.field} className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                'flex size-4 shrink-0 items-center justify-center',
                !selecting &&
                  'opacity-0 group-hover/artifact-table:opacity-100 group-focus-within/list-table-header:opacity-100'
              )}
            >
              <Checkbox
                checked={selectAllState}
                disabled={!canSelectAll}
                aria-label={t(
                  'auto.components.artifacts.ArtifactListTableHeader.selectAll',
                  'Select all'
                )}
                onCheckedChange={onToggleAll}
              />
            </span>
            {sortHeader}
          </span>
        ) : (
          <span
            key={column.field}
            className={cn('min-w-0', column.wideOnly && ARTIFACTS_TABLE_WIDE_ONLY_CLASS)}
          >
            {sortHeader}
          </span>
        )
      })}
      <span className="sr-only">
        {t('auto.components.artifacts.ArtifactListTableHeader.actions', 'Actions')}
      </span>
    </div>
  )
}
