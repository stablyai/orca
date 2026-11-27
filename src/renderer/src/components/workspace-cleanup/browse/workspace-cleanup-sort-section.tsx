import React from 'react'
import { ArrowDown, ArrowUp, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { WORKSPACE_CLEANUP_SORT_FIELD_VALUES } from '../../../../../shared/workspace-cleanup/workspace-cleanup-facet-rankings'
import type {
  WorkspaceCleanupSortField,
  WorkspaceCleanupSortState
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-filter-model'
import { getWorkspaceCleanupSortFieldLabel } from './workspace-cleanup-facet-labels'

/** Present while sizes are unmeasured or a scan runs; the button is the one way to fill sizes. */
export type WorkspaceCleanupSizeScanAction = {
  scanning: boolean
  scannedCount: number
  totalCount: number
  onRun: () => void
}

/** Sort and size measuring live with the filters: they shape the list rather than act on it. */
export function WorkspaceCleanupSortSection({
  sort,
  sizeScan,
  onToggleSortField
}: {
  sort: WorkspaceCleanupSortState
  sizeScan: WorkspaceCleanupSizeScanAction | null
  onToggleSortField: (field: WorkspaceCleanupSortField) => void
}): React.JSX.Element {
  const t = useTranslate()
  const DirectionIcon = sort.direction === 'asc' ? ArrowUp : ArrowDown
  return (
    <div className="border-b border-border px-3 py-2.5">
      <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
        {t('components.workspace.cleanup.browse.sortBy', 'Sort by')}
      </p>
      <div className="flex flex-wrap gap-1">
        {WORKSPACE_CLEANUP_SORT_FIELD_VALUES.map((field) => {
          const active = sort.field === field
          return (
            <Button
              key={field}
              variant={active ? 'secondary' : 'ghost'}
              size="xs"
              aria-pressed={active}
              onClick={() => onToggleSortField(field)}
            >
              <span className={cn(!active && 'text-muted-foreground')}>
                {getWorkspaceCleanupSortFieldLabel(field, t)}
              </span>
              {active ? (
                <>
                  <DirectionIcon className="size-3" aria-hidden="true" />
                  <span className="sr-only">
                    {sort.direction === 'asc'
                      ? t('components.workspace.cleanup.browse.sortAscending', 'ascending')
                      : t('components.workspace.cleanup.browse.sortDescending', 'descending')}
                  </span>
                </>
              ) : null}
            </Button>
          )
        })}
      </div>
      {sizeScan ? <SizeScanButton {...sizeScan} /> : null}
    </div>
  )
}

function SizeScanButton({
  scanning,
  scannedCount,
  totalCount,
  onRun
}: WorkspaceCleanupSizeScanAction): React.JSX.Element {
  const t = useTranslate()
  const label = !scanning
    ? t('components.workspace.cleanup.browse.measureSizesTitle', 'Scan workspace sizes')
    : totalCount > 0
      ? t(
          'components.workspace.cleanup.browse.measuringSizesProgress',
          'Scanning {{value0}}/{{value1}}',
          { value0: scannedCount, value1: totalCount }
        )
      : t('components.workspace.cleanup.browse.measuringSizes', 'Scanning sizes')
  return (
    <Button variant="outline" size="xs" className="mt-2" disabled={scanning} onClick={onRun}>
      {scanning ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : null}
      <span className="tabular-nums">{label}</span>
    </Button>
  )
}
