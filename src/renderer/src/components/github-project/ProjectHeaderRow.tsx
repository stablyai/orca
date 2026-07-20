import React from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3, ListTree } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import ColumnResizeHandle from './ColumnResizeHandle'
import { minColumnWidthFor, resolveWidth } from './column-widths'
import type {
  GitHubProjectField,
  GitHubProjectSortDirection
} from '../../../../shared/github-project-types'
import { translate } from '@/i18n/i18n'

// Why: the override state lives in ProjectViewList but the type is defined
// here so the module dependency stays one-directional (list → header).
export type SortOverride = { fieldId: string; direction: GitHubProjectSortDirection }

const PROJECT_FROZEN_COLUMN_HEADER_SURFACE_CLASS =
  '[background:color-mix(in_srgb,var(--background)_95%,var(--muted))]'

type Props = {
  fields: GitHubProjectField[]
  availableFields: GitHubProjectField[]
  hidden: ReadonlySet<string>
  onToggleColumn: (fieldId: string) => void
  activeSort: SortOverride | null
  onSortClick: (fieldId: string) => void
  widths: Readonly<Record<string, number>>
  gridTemplate: string
  onResizeColumn: (fieldId: string, width: number, nextFieldId: string, nextWidth: number) => void
  hierarchyMode: boolean
  onToggleHierarchyMode: () => void
}

export default function ProjectHeaderRow({
  fields,
  availableFields,
  hidden,
  onToggleColumn,
  activeSort,
  onSortClick,
  widths,
  gridTemplate,
  onResizeColumn,
  hierarchyMode,
  onToggleHierarchyMode
}: Props): React.JSX.Element {
  // Why: matches GitHub Projects' fixed column header — sticky so it stays
  // pinned while scrolling the rows beneath it. The trailing slot mirrors the
  // hover-action column in ProjectRow so columns line up exactly.
  return (
    <div
      className="sticky top-0 z-10 grid items-center gap-3 border-b border-border/60 bg-background/95 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur"
      style={{ gridTemplateColumns: gridTemplate }}
    >
      {fields.map((f, idx) => {
        const isActive = activeSort?.fieldId === f.id
        const Icon = isActive ? (activeSort.direction === 'ASC' ? ArrowUp : ArrowDown) : ArrowUpDown
        // Why: only render a resize handle when there is a neighbor to
        // borrow width from. The trailing field has no field neighbor on
        // its right (the action column is fixed and not part of the
        // user-resizable pair set), so omit its handle to keep the total
        // table width invariant.
        const next = fields[idx + 1]
        const frozen = idx < 2
        return (
          <div
            key={f.id}
            className={cn(
              'flex min-w-0 items-center',
              !frozen && 'relative',
              frozen &&
                cn(
                  'relative z-20 backdrop-blur before:absolute before:-left-3 before:top-0 before:bottom-0 before:w-3 before:bg-inherit',
                  PROJECT_FROZEN_COLUMN_HEADER_SURFACE_CLASS
                ),
              idx === 1 && 'border-r border-border/50'
            )}
            style={
              frozen ? { transform: 'translateX(var(--project-scroll-left, 0px))' } : undefined
            }
          >
            <button
              type="button"
              onClick={() => onSortClick(f.id)}
              className={cn(
                'group flex min-w-0 flex-1 items-center gap-1 truncate text-left uppercase tracking-wide hover:text-foreground',
                isActive && 'text-foreground'
              )}
              aria-label={translate(
                'auto.components.github.project.ProjectViewList.eddfc7a794',
                'Sort by {{value0}}',
                { value0: f.name }
              )}
            >
              <span className="truncate">{f.name}</span>
              <Icon
                className={cn(
                  'size-3 shrink-0 transition-opacity',
                  isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-60'
                )}
              />
            </button>
            {next ? (
              <ColumnResizeHandle
                fieldId={f.id}
                nextFieldId={next.id}
                currentWidth={resolveWidth(f, widths)}
                nextWidth={resolveWidth(next, widths)}
                minWidth={minColumnWidthFor(f)}
                nextMinWidth={minColumnWidthFor(next)}
                onResize={onResizeColumn}
              />
            ) : null}
          </div>
        )
      })}
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={onToggleHierarchyMode}
          aria-pressed={hierarchyMode}
          aria-label={translate(
            'auto.components.github.project.ProjectViewList.hierarchyToggle',
            'Show hierarchy'
          )}
          className={cn(
            'rounded p-1 hover:bg-muted hover:text-foreground',
            hierarchyMode ? 'bg-muted text-foreground' : 'text-muted-foreground'
          )}
        >
          <ListTree className="size-3.5" />
        </button>
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={translate(
                'auto.components.github.project.ProjectViewList.f949f5b2b7',
                'Configure columns'
              )}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Columns3 className="size-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 p-1">
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              {translate('auto.components.github.project.ProjectViewList.989f81dc2a', 'Columns')}
            </div>
            {availableFields.map((f) => {
              // Why: TITLE is the only column that anchors the row's identity
              // and click target — disallow hiding it so users can't end up
              // with a row of metadata they can't open.
              const locked = f.dataType === 'TITLE'
              const visible = !hidden.has(f.id)
              return (
                <label
                  key={f.id}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted/50',
                    locked && 'cursor-not-allowed opacity-60'
                  )}
                >
                  <input
                    type="checkbox"
                    checked={visible}
                    disabled={locked}
                    onChange={() => onToggleColumn(f.id)}
                    className="size-3.5"
                  />
                  <span className="truncate">{f.name}</span>
                </label>
              )
            })}
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}
