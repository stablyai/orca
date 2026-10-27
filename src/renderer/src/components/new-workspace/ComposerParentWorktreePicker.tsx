import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronsUpDown, GitBranch } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Button } from '@/components/ui/button'
import { Command, CommandInput, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  getIndexedAllWorktrees,
  getIndexedWorktreeById,
  getIndexedWorktreeMap
} from '@/store/worktree-repo-index'
import { compareWorktreeDisplayName } from '@/lib/worktree-display-name-order'
import { branchDisplayName } from '@/components/sidebar/WorktreeCardHelpers'
import { getCyclicProjectedWorktreeLineageIds } from '../../../../shared/sidebar-list/worktree-lineage-projection'
import {
  clampWorktreeParentPickerIndex,
  filterWorktreeParentCandidates
} from '@/components/sidebar/worktree-parent-picker-filtering'
import {
  PICKER_LIST_MAX_HEIGHT,
  PICKER_ROW_HEIGHT,
  PICKER_ROW_OVERSCAN
} from '@/components/sidebar/worktree-parent-picker-placement'
import {
  getLineageChildrenByParentId,
  getLineageChildWorktree
} from '@/components/right-sidebar/folder-workspace-attached-worktrees'
import { COMBOBOX_POPOVER_SURFACE } from './type-ahead-combobox-styles'
import {
  sharesWorktreeLineageBoundary,
  type WorktreeLineageBoundary
} from '../../../../shared/resolved-worktree-lineage'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { WorkspaceLineage, WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  getRepoExecutionHostId,
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { useRepoMap } from '@/store/selectors'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'

/** 20px text leading plus py-2 matches the explicit row height. */
const NO_PARENT_ROW_HEIGHT = 36
const NO_PARENT_ROW_KEY = 'no-parent'

type ComposerParentWorktreePickerProps = {
  repoId: string
  /** Parent must belong to the same execution host that will create the child. */
  executionHostId?: ExecutionHostId | null
  projectId?: string | null
  value: string | null
  onChange: (id: string | null) => void
  disabled?: boolean
  /** When the active workspace is a folder, restrict candidates to that folder's subtree. */
  activeFolderWorkspaceId?: string | null
}

type ParentWorktreeCandidateListProps = {
  repoId: string
  executionHostId?: ExecutionHostId | null
  projectId?: string | null
  value: string | null
  activeFolderWorkspaceId: string | null
  onSelect: (id: string | null) => void
}

/** Pick nesting without changing the base branch; enumerate only in Radix’s open-only list, leaving closed state a string selector. */
function ComposerParentWorktreePickerImpl({
  repoId,
  executionHostId,
  projectId,
  value,
  onChange,
  disabled = false,
  activeFolderWorkspaceId = null
}: ComposerParentWorktreePickerProps): React.JSX.Element {
  // Subscribe so translate() refreshes on language changes.
  useTranslation()
  const [open, setOpen] = useState(false)
  const labelId = `${useId()}label`

  // Archived parents cannot produce sidebar nesting, so do not promise it with a retained name.
  const parentName = useAppStore((s) => {
    if (!value) {
      return null
    }
    const parent = getIndexedWorktreeById(selectWorktreesByRepo(s), value)
    return parent && !parent.isArchived ? parent.displayName : null
  })

  // Close during render when the drawer disables its trigger; portaled content would otherwise linger through a stale-open frame.
  if (open && disabled) {
    setOpen(false)
  }

  const handleSelect = useCallback(
    (nextId: string | null) => {
      onChange(nextId)
      setOpen(false)
    },
    [onChange]
  )

  return (
    <div className="space-y-1.5">
      <span id={labelId} className="block text-xs font-medium text-muted-foreground">
        {translate('auto.components.ComposerParentWorktreePicker.label', 'Parent worktree')}
      </span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-labelledby={labelId}
            disabled={disabled}
            className="h-9 w-full justify-between border-input px-3 text-sm font-normal text-foreground focus:border-ring focus:ring-[3px] focus:ring-ring/50"
          >
            <span className="truncate">
              {parentName ??
                translate('auto.components.ComposerParentWorktreePicker.noParent', 'No parent')}
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className={cn(
            'flex w-[var(--radix-popover-trigger-width)] min-w-[17rem] flex-col p-0',
            COMBOBOX_POPOVER_SURFACE
          )}
          // Focus search instead of Radix’s content wrapper.
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            const content = event.currentTarget
            if (content instanceof HTMLElement) {
              content.querySelector<HTMLInputElement>('[data-slot="command-input"]')?.focus()
            }
          }}
        >
          <ParentWorktreeCandidateList
            repoId={repoId}
            executionHostId={executionHostId}
            projectId={projectId}
            value={value}
            activeFolderWorkspaceId={activeFolderWorkspaceId}
            onSelect={handleSelect}
          />
        </PopoverContent>
      </Popover>
      <p className="text-[11px] text-muted-foreground">
        {translate(
          'auto.components.ComposerParentWorktreePicker.description',
          'Nests this workspace under another in the sidebar. Does not change the base branch.'
        )}
      </p>
    </div>
  )
}

/** Worktrees reachable from the folder workspace, so a pick can't drop the new one out of it. */
function getFolderWorkspaceSubtreeIds(
  folderWorkspaceId: string,
  workspaceLineageByChildKey: Readonly<Record<string, WorkspaceLineage>>,
  worktreeLineageById: Record<string, WorktreeLineage>,
  worktreeById: Map<string, Worktree>
): Set<string> {
  const folderKey = folderWorkspaceKey(folderWorkspaceId)
  const rootIds = new Set<string>()
  for (const lineage of Object.values(workspaceLineageByChildKey)) {
    if (lineage.parentWorkspaceKey !== folderKey) {
      continue
    }
    // Exclude archived/instance-stale parents whose subtree the folder view cannot show.
    const rootWorktree = getLineageChildWorktree(lineage, worktreeById)
    if (rootWorktree) {
      rootIds.add(rootWorktree.id)
    }
  }

  const subtreeIds = new Set(rootIds)
  for (const children of getLineageChildrenByParentId(
    worktreeLineageById,
    worktreeById,
    rootIds
  ).values()) {
    for (const child of children) {
      subtreeIds.add(child.id)
    }
  }
  return subtreeIds
}

function ParentWorktreeCandidateList({
  repoId,
  executionHostId,
  value,
  activeFolderWorkspaceId,
  onSelect
}: ParentWorktreeCandidateListProps): React.JSX.Element {
  const worktreesByRepo = useAppStore((s) => selectWorktreesByRepo(s))
  const repoMap = useRepoMap()
  const worktreeLineageById = useAppStore((s) => s.worktreeLineageById)
  const workspaceLineageByChildKey = useAppStore((s) => s.workspaceLineageByChildKey)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const optionIdPrefix = `${useId()}option`
  const [search, setSearch] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)

  const candidates = useMemo(() => {
    // Legacy rows inherit their real repo host, including candidates from another project.
    const childRepo = repoMap.get(repoId)
    const childBoundary: WorktreeLineageBoundary = {
      hostId: executionHostId ?? (childRepo ? getRepoExecutionHostId(childRepo) : undefined)
    }
    const worktreeMap = getIndexedWorktreeMap(worktreesByRepo)
    const cyclicLineageIds = getCyclicProjectedWorktreeLineageIds(worktreeLineageById, worktreeMap)
    const folderSubtreeIds = activeFolderWorkspaceId
      ? getFolderWorkspaceSubtreeIds(
          activeFolderWorkspaceId,
          workspaceLineageByChildKey,
          worktreeLineageById,
          worktreeMap
        )
      : null
    return getIndexedAllWorktrees(worktreesByRepo)
      .filter(
        (candidate) =>
          !candidate.isArchived &&
          sharesWorktreeLineageBoundary(childBoundary, {
            ...candidate,
            hostId: getWorktreeExecutionHostId(candidate, repoMap.get(candidate.repoId))
          }) &&
          !cyclicLineageIds.has(candidate.id) &&
          (folderSubtreeIds === null || folderSubtreeIds.has(candidate.id))
      )
      .sort(compareWorktreeDisplayName)
  }, [
    activeFolderWorkspaceId,
    executionHostId,
    repoId,
    repoMap,
    workspaceLineageByChildKey,
    worktreeLineageById,
    worktreesByRepo
  ])

  const filtered = useMemo(
    () => filterWorktreeParentCandidates(candidates, search, repoMap),
    [candidates, search, repoMap]
  )
  const activeIndex = clampWorktreeParentPickerIndex(highlightedIndex, filtered.length + 1)

  // Virtualize No parent at index 0; external rows would shift geometry and make scrollToIndex land short.
  const virtualizer = useVirtualizer({
    count: filtered.length + 1,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => (index === 0 ? NO_PARENT_ROW_HEIGHT : PICKER_ROW_HEIGHT),
    overscan: PICKER_ROW_OVERSCAN,
    getItemKey: (index) => (index === 0 ? NO_PARENT_ROW_KEY : (filtered[index - 1]?.id ?? index)),
    // Seed the viewport until the popover measures next frame to avoid blank first paint.
    initialRect: { width: 0, height: PICKER_LIST_MAX_HEIGHT }
  })

  const moveHighlight = useCallback(
    (nextIndex: number) => {
      setHighlightedIndex(nextIndex)
      virtualizer.scrollToIndex(nextIndex, { align: 'auto' })
    },
    [virtualizer]
  )

  const handleSearchChange = useCallback(
    (nextSearch: string) => {
      // Re-ranking invalidates the highlight; typing arms the top match, while no matches clamp to No parent.
      setSearch(nextSearch)
      setHighlightedIndex(nextSearch.trim().length > 0 ? 1 : 0)
      virtualizer.scrollToOffset(0)
    },
    [virtualizer]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      // Why: cmdk's root handler only knows the mounted virtual window, so own navigation here.
      const navigate = (nextIndex: number): void => {
        event.preventDefault()
        event.stopPropagation()
        moveHighlight(clampWorktreeParentPickerIndex(nextIndex, filtered.length + 1))
      }
      if (event.key === 'ArrowDown') {
        navigate(activeIndex + 1)
      } else if (event.key === 'ArrowUp') {
        navigate(activeIndex - 1)
      } else if (event.key === 'Home') {
        navigate(0)
      } else if (event.key === 'End') {
        navigate(filtered.length)
      } else if (event.key === 'Enter') {
        const candidate = activeIndex === 0 ? null : filtered[activeIndex - 1]
        if (activeIndex === 0 || candidate) {
          event.preventDefault()
          event.stopPropagation()
          onSelect(candidate?.id ?? null)
        }
      }
    },
    [activeIndex, filtered, moveHighlight, onSelect]
  )

  // cmdk points aria-activedescendant at its empty registry; restore our virtual selection after each commit.
  useEffect(() => {
    inputRef.current?.setAttribute('aria-activedescendant', `${optionIdPrefix}-${activeIndex}`)
  })

  const virtualRows = virtualizer.getVirtualItems()

  return (
    <Command shouldFilter={false} className="min-h-0 bg-transparent">
      <CommandInput
        ref={inputRef}
        value={search}
        onValueChange={handleSearchChange}
        onKeyDown={handleKeyDown}
        wrapperClassName="shrink-0"
        placeholder={translate(
          'auto.components.ComposerParentWorktreePicker.searchPlaceholder',
          'Search workspaces...'
        )}
      />
      <CommandList ref={listRef} className="max-h-72 min-h-0 flex-1">
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualRows.map((virtualRow) => {
            const rowIndex = virtualRow.index
            const candidate = rowIndex === 0 ? null : filtered[rowIndex - 1]
            if (rowIndex !== 0 && !candidate) {
              return null
            }
            const isHighlighted = rowIndex === activeIndex
            return (
              <div
                key={virtualRow.key}
                id={`${optionIdPrefix}-${rowIndex}`}
                role="option"
                aria-selected={(candidate?.id ?? null) === value}
                data-selected={isHighlighted || undefined}
                // Why `jump-palette-item`: selection chrome lives in main.css — flat accent is invisible on light popovers.
                className="jump-palette-item absolute left-0 top-0 flex w-full cursor-default select-none items-center gap-2 overflow-hidden rounded-sm px-2 py-2 text-sm outline-none"
                style={{
                  height: virtualRow.size,
                  transform: `translateY(${virtualRow.start}px)`
                }}
                onPointerMove={() => setHighlightedIndex(rowIndex)}
                onClick={() => onSelect(candidate?.id ?? null)}
              >
                <Check
                  className={cn(
                    'size-3.5 shrink-0',
                    (candidate?.id ?? null) !== value && 'opacity-0'
                  )}
                />
                {candidate ? (
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{candidate.displayName}</div>
                    <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] leading-none text-muted-foreground">
                      <GitBranch className="size-3 shrink-0" />
                      <span className="truncate">
                        {[
                          repoMap.get(candidate.repoId)?.displayName,
                          branchDisplayName(candidate.branch)
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </div>
                  </div>
                ) : (
                  <span className="truncate">
                    {translate(
                      'auto.components.ComposerParentWorktreePicker.noParent',
                      'No parent'
                    )}
                  </span>
                )}
              </div>
            )
          })}
        </div>
        {filtered.length === 0 && search.trim().length > 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            {translate('auto.components.ComposerParentWorktreePicker.noMatches', 'No matches.')}
          </div>
        ) : null}
      </CommandList>
    </Command>
  )
}

/** Stable props let memo stop per-keystroke composer renders before the popover subtree. */
export const ComposerParentWorktreePicker = React.memo(ComposerParentWorktreePickerImpl)

export default ComposerParentWorktreePicker
