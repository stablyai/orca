// One group on Home: Pinned, a section, or "No section". Named sections collapse; every group's
// rows reorder by dragging (or Move up / Move down in the row menu), and the order syncs to your
// other devices through your prefs.
import React, { useState } from 'react'
import { ChevronRight, MoreHorizontal, Pin } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type { CloudWorkspaceGroup } from '../../../../shared/cloud-workspaces/cloud-workspace-arrangement'
import type { CloudWorkspace } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'

type Group = CloudWorkspaceGroup<CloudWorkspace>

export type GroupDrag = {
  /** The row being dragged and the group it came from (rows only drop within their own group). */
  dragging: { id: string; group: string } | null
  start: (id: string, group: string) => void
  drop: (overId: string, group: string) => void
  end: () => void
}

/** Drag props for one row's <li>; inert while reduced to a single row. */
export function rowDragProps(
  drag: GroupDrag,
  group: Group,
  id: string
): React.LiHTMLAttributes<HTMLLIElement> & { 'data-drop-target'?: string } {
  if (group.rows.length < 2) {
    return {}
  }
  return {
    draggable: true,
    onDragStart: (event) => {
      event.dataTransfer.effectAllowed = 'move'
      // Some platforms need data set for the drag to start at all.
      event.dataTransfer.setData('text/plain', id)
      drag.start(id, group.key)
    },
    onDragOver: (event) => {
      if (drag.dragging?.group === group.key) {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }
    },
    onDrop: (event) => {
      if (drag.dragging?.group === group.key) {
        event.preventDefault()
        drag.drop(id, group.key)
      }
    },
    onDragEnd: () => drag.end()
  }
}

export function CloudWorkspaceGroupView({
  group,
  index,
  showHeading,
  canMoveUp,
  canMoveDown,
  onToggleCollapsed,
  onMoveSection,
  children
}: {
  group: Group
  index: number
  showHeading: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onToggleCollapsed: (collapsed: boolean) => void
  onMoveSection: (delta: number) => void
  children: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const [menuOpen, setMenuOpen] = useState(false)
  // Section names are free text (spaces), so the id uses the position instead.
  const headingId = `cloud-workspaces-section-${index}`
  const listId = `cloud-workspaces-section-list-${index}`
  const label =
    group.kind === 'pinned'
      ? t('auto.components.cloudWorkspaces.pinned', 'Pinned')
      : (group.section ?? t('auto.components.cloudWorkspaces.otherWorkspaces', 'Other workspaces'))
  const count = (
    <>
      {/* The bare number is visual; screen readers get the counted phrase. */}
      <span aria-hidden className="ml-1.5 tabular-nums text-muted-foreground">
        {group.rows.length}
      </span>{' '}
      <span className="sr-only">
        {t('auto.components.cloudWorkspaces.sectionCount', '{{count}} workspaces', {
          count: group.rows.length,
          defaultValue_one: '{{count}} workspace'
        })}
      </span>
    </>
  )
  const collapsible = group.kind === 'section'
  return (
    <div className="py-0.5" data-cloud-workspace-group={group.key}>
      {showHeading && (
        <div className="group/heading flex items-center gap-1 pr-2">
          <h3 id={headingId} className="min-w-0 flex-1 text-2xs font-medium text-muted-foreground">
            {collapsible ? (
              <button
                type="button"
                aria-expanded={!group.collapsed}
                aria-controls={listId}
                onClick={() => onToggleCollapsed(!group.collapsed)}
                className="flex w-full items-center gap-1 rounded-md px-3 py-2 text-left outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-focus-ring"
              >
                <ChevronRight
                  aria-hidden
                  className={cn(
                    '-ml-1 size-3 shrink-0 motion-safe:transition-transform',
                    !group.collapsed && 'rotate-90'
                  )}
                />
                <span className="truncate">{label}</span>
                {count}
              </button>
            ) : (
              <span className="flex items-center gap-1 px-3 py-2">
                {group.kind === 'pinned' && <Pin aria-hidden className="-ml-0.5 size-3 shrink-0" />}
                <span className="truncate">{label}</span>
                {count}
              </span>
            )}
          </h3>
          {collapsible && (canMoveUp || canMoveDown) && (
            <span
              className={cn(
                'opacity-0 group-focus-within/heading:opacity-100 group-hover/heading:opacity-100',
                menuOpen && 'opacity-100'
              )}
            >
              <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={t(
                      'auto.components.cloudWorkspaces.sectionActions',
                      'Actions for section {{name}}',
                      { name: label }
                    )}
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem disabled={!canMoveUp} onSelect={() => onMoveSection(-1)}>
                    {t('auto.components.cloudWorkspaces.moveSectionUp', 'Move section up')}
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={!canMoveDown} onSelect={() => onMoveSection(1)}>
                    {t('auto.components.cloudWorkspaces.moveSectionDown', 'Move section down')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          )}
        </div>
      )}
      {!group.collapsed && (
        <ul
          id={listId}
          role="list"
          aria-labelledby={showHeading ? headingId : 'cloud-workspaces-heading'}
        >
          {children}
        </ul>
      )}
    </div>
  )
}
