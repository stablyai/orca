import React, { useRef } from 'react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import {
  WORKSPACE_CLEANUP_GROUPS,
  type WorkspaceCleanupGroup
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-groups'

export const WORKSPACE_CLEANUP_GROUP_PANEL_ID = 'workspace-cleanup-group-panel'

export function getWorkspaceCleanupGroupTabId(group: WorkspaceCleanupGroup): string {
  return `workspace-cleanup-group-tab-${group}`
}

/** Returns focus to a group tab after the step that replaced the browse view unmounts. */
export function focusWorkspaceCleanupGroupTab(group: WorkspaceCleanupGroup): void {
  requestAnimationFrame(() =>
    document.getElementById(getWorkspaceCleanupGroupTabId(group))?.focus()
  )
}

export type WorkspaceCleanupGroupSummary = {
  count: number
  /** Rows the user ticked in this group; shown only when above zero. */
  selectedCount: number
}

export function WorkspaceCleanupGroupCards({
  active,
  summaries,
  onChange
}: {
  active: WorkspaceCleanupGroup
  summaries: Readonly<Record<WorkspaceCleanupGroup, WorkspaceCleanupGroupSummary>>
  onChange: (group: WorkspaceCleanupGroup) => void
}): React.JSX.Element {
  const t = useTranslate()
  const tabRefs = useRef(new Map<WorkspaceCleanupGroup, HTMLButtonElement>())
  const names: Record<WorkspaceCleanupGroup, string> = {
    'nothing-local': t('components.workspace.cleanup.group.nothingLocal', 'Nothing local'),
    'local-files': t('components.workspace.cleanup.group.localFiles', 'Has local files'),
    'cannot-delete': t('components.workspace.cleanup.group.cannotDelete', "Can't delete")
  }

  const moveTo = (index: number): void => {
    const next = WORKSPACE_CLEANUP_GROUPS[(index + WORKSPACE_CLEANUP_GROUPS.length) % 3]
    onChange(next)
    tabRefs.current.get(next)?.focus()
  }
  const handleKeyDown = (event: React.KeyboardEvent, index: number): void => {
    if (event.key === 'ArrowRight') {
      moveTo(index + 1)
    } else if (event.key === 'ArrowLeft') {
      moveTo(index - 1)
    } else if (event.key === 'Home') {
      moveTo(0)
    } else if (event.key === 'End') {
      moveTo(WORKSPACE_CLEANUP_GROUPS.length - 1)
    } else {
      return
    }
    event.preventDefault()
  }

  return (
    <div
      role="tablist"
      aria-label={t('components.workspace.cleanup.group.label', 'Workspace groups')}
      className="grid grid-cols-3 gap-2 border-b border-border px-4 py-3"
    >
      {WORKSPACE_CLEANUP_GROUPS.map((group, index) => {
        const isActive = group === active
        const warning = group === 'local-files'
        const { count, selectedCount } = summaries[group]
        return (
          <button
            key={group}
            ref={(element) => {
              if (element) {
                tabRefs.current.set(group, element)
              } else {
                tabRefs.current.delete(group)
              }
            }}
            id={getWorkspaceCleanupGroupTabId(group)}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={WORKSPACE_CLEANUP_GROUP_PANEL_ID}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(group)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            // The open card's 2px edge is a 1px border plus an inset ring, so cards never resize.
            className={cn(
              'flex min-h-14 min-w-0 flex-col justify-center gap-0.5 rounded-lg border px-3 py-2 text-left outline-none transition-colors',
              'focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background',
              isActive
                ? warning
                  ? 'border-status-warning bg-status-warning-background ring-1 ring-inset ring-status-warning'
                  : 'border-foreground ring-1 ring-inset ring-foreground'
                : 'border-border hover:bg-accent/40'
            )}
          >
            <span className="flex min-w-0 items-baseline justify-between gap-2">
              <span
                className={cn(
                  'truncate text-sm font-medium',
                  warning ? 'text-status-warning-text' : 'text-foreground'
                )}
              >
                {names[group]}
              </span>
              <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
                {count}
              </span>
            </span>
            {selectedCount > 0 ? (
              <span className="truncate text-xs text-muted-foreground">
                {t('components.workspace.cleanup.group.selected', '{{count}} selected', {
                  count: selectedCount
                })}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
