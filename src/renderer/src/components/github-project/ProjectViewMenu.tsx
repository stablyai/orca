import React from 'react'
import {
  Columns3,
  KanbanSquare,
  ListChecks,
  Map as MapIcon,
  RotateCcw,
  Rows3,
  Settings2,
  Table as TableIcon,
  type LucideIcon
} from 'lucide-react'
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
import { translate } from '@/i18n/i18n'
import {
  hasProjectViewLayoutOverrides,
  isBoardColumnField,
  isGroupableField,
  projectFieldPool,
  type ProjectViewLayoutOverrides
} from './project-view-layout-overrides'
import {
  resolveBoardColumnField,
  resolveBoardSwimlaneField
} from '../../../../shared/github/project-board-columns'
import type {
  GitHubProjectTable,
  GitHubProjectViewLayout
} from '../../../../shared/github/project-types'

const NO_GROUP_VALUE = '__none__'

const LAYOUTS: {
  layout: GitHubProjectViewLayout
  Icon: LucideIcon
  label: () => string
}[] = [
  {
    layout: 'TABLE_LAYOUT',
    Icon: TableIcon,
    label: () => translate('projectViewMenu.layout.table', 'Table')
  },
  {
    layout: 'BOARD_LAYOUT',
    Icon: KanbanSquare,
    label: () => translate('projectViewMenu.layout.board', 'Board')
  },
  {
    layout: 'ROADMAP_LAYOUT',
    Icon: MapIcon,
    label: () => translate('projectViewMenu.layout.roadmap', 'Roadmap')
  }
]

type Props = {
  /** The fetched table, before overrides — the source of every field choice. */
  table: GitHubProjectTable
  /** The same table with overrides applied — what the body renders. */
  effectiveTable: GitHubProjectTable
  overrides: ProjectViewLayoutOverrides | undefined
  onChange: (patch: ProjectViewLayoutOverrides) => void
  onReset: () => void
}

export function ProjectViewMenu({
  table,
  effectiveTable,
  overrides,
  onChange,
  onReset
}: Props): React.JSX.Element {
  const view = effectiveTable.selectedView
  const pool = projectFieldPool(table)
  const visibleIds = new Set(view.fields.map((field) => field.id))
  const columnField = resolveBoardColumnField(view)
  const groupField =
    view.layout === 'BOARD_LAYOUT'
      ? resolveBoardSwimlaneField(view, columnField)
      : (view.groupByFields[0] ?? null)
  const board = view.layout === 'BOARD_LAYOUT'
  const currentLayout = LAYOUTS.find((entry) => entry.layout === view.layout)
  const CurrentLayoutIcon = currentLayout?.Icon ?? TableIcon
  const noneLabel = translate('projectViewMenu.none', 'none')
  const groupLabel = board
    ? translate('projectViewMenu.swimlanes', 'Swimlanes:')
    : translate('projectViewMenu.groupBy', 'Group by:')
  const modified = hasProjectViewLayoutOverrides(overrides)
  // Choosing GitHub's own value clears that override instead of pinning a copy of it.
  const githubView = table.selectedView
  const githubFieldIds = githubView.fields.map((field) => field.id).join('\n')
  const githubColumnId = resolveBoardColumnField(githubView)?.id
  const githubGroupId = githubView.groupByFields[0]?.id ?? null

  const toggleField = (fieldId: string): void => {
    const next = new Set(visibleIds)
    if (!next.delete(fieldId)) {
      next.add(fieldId)
    }
    const fieldIds = pool.filter((field) => next.has(field.id)).map((field) => field.id)
    onChange({
      fieldIds: fieldIds.join('\n') === githubFieldIds ? undefined : fieldIds
    })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="xs"
          aria-label={
            modified
              ? translate('projectViewMenu.triggerModified', 'View options (changed in Orca)')
              : translate('projectViewMenu.trigger', 'View options')
          }
        >
          <Settings2 />
          {translate('projectViewMenu.view', 'View')}
          {modified ? <span aria-hidden className="size-1.5 rounded-full bg-primary" /> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <CurrentLayoutIcon />
            <span className="text-muted-foreground">
              {translate('projectViewMenu.layoutLabel', 'Layout:')}
            </span>
            <span className="min-w-0 flex-1 truncate text-right">{currentLayout?.label()}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={view.layout}
              onValueChange={(value) => {
                const layout = LAYOUTS.find((entry) => entry.layout === value)?.layout
                onChange({ layout: layout === githubView.layout ? undefined : layout })
              }}
            >
              {LAYOUTS.map(({ layout, Icon, label }) => (
                <DropdownMenuRadioItem key={layout} value={layout}>
                  <Icon />
                  {label()}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <ListChecks />
            <span className="text-muted-foreground">
              {translate('projectViewMenu.fields', 'Fields:')}
            </span>
            <span className="min-w-0 flex-1 truncate text-right">
              {view.fields.map((field) => field.name).join(', ')}
            </span>
          </DropdownMenuSubTrigger>
          <ScrollingSubmenu>
            {pool.map((field) => (
              <DropdownMenuCheckboxItem
                key={field.id}
                checked={visibleIds.has(field.id)}
                disabled={field.dataType === 'TITLE'}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={() => toggleField(field.id)}
              >
                <span className="truncate">{field.name}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </ScrollingSubmenu>
        </DropdownMenuSub>
        {board ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Columns3 />
              <span className="text-muted-foreground">
                {translate('projectViewMenu.columnBy', 'Column by:')}
              </span>
              <span className="min-w-0 flex-1 truncate text-right">
                {columnField?.name ?? noneLabel}
              </span>
            </DropdownMenuSubTrigger>
            <ScrollingSubmenu>
              <DropdownMenuRadioGroup
                value={columnField?.id ?? ''}
                onValueChange={(columnFieldId) =>
                  onChange({
                    columnFieldId: columnFieldId === githubColumnId ? undefined : columnFieldId
                  })
                }
              >
                {pool.filter(isBoardColumnField).map((field) => (
                  <DropdownMenuRadioItem key={field.id} value={field.id}>
                    <span className="truncate">{field.name}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </ScrollingSubmenu>
          </DropdownMenuSub>
        ) : null}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Rows3 />
            <span className="text-muted-foreground">{groupLabel}</span>
            <span className="min-w-0 flex-1 truncate text-right">
              {groupField?.name ?? noneLabel}
            </span>
          </DropdownMenuSubTrigger>
          <ScrollingSubmenu>
            <DropdownMenuRadioGroup
              value={groupField?.id ?? NO_GROUP_VALUE}
              onValueChange={(value) => {
                const groupFieldId = value === NO_GROUP_VALUE ? null : value
                onChange({
                  groupFieldId: groupFieldId === githubGroupId ? undefined : groupFieldId
                })
              }}
            >
              <DropdownMenuRadioItem value={NO_GROUP_VALUE}>
                {board
                  ? translate('projectViewMenu.noSwimlanes', 'No swimlanes')
                  : translate('projectViewMenu.noGrouping', 'No grouping')}
              </DropdownMenuRadioItem>
              {pool
                .filter(
                  (field) => isGroupableField(field) && (!board || field.id !== columnField?.id)
                )
                .map((field) => (
                  <DropdownMenuRadioItem key={field.id} value={field.id}>
                    <span className="truncate">{field.name}</span>
                  </DropdownMenuRadioItem>
                ))}
            </DropdownMenuRadioGroup>
          </ScrollingSubmenu>
        </DropdownMenuSub>
        {modified ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onReset}>
              <RotateCcw />
              {translate('projectViewMenu.reset', 'Reset to the GitHub view')}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// Projects can carry up to 50 fields; scroll inside the submenu instead of off-screen.
function ScrollingSubmenu({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <DropdownMenuSubContent>
      <div className="max-h-80 overflow-y-auto scrollbar-sleek">{children}</div>
    </DropdownMenuSubContent>
  )
}
