import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronsUpDown, GitBranch } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Button } from '@/components/ui/button'
import { Command, CommandInput, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  isImeCompositionKeyDown,
  useImeEnterGestureOwnership
} from '@/lib/ime-composition-keyboard-event'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  getIndexedAllWorktrees,
  getIndexedWorktreeById,
  getIndexedWorktreeMap
} from '@/store/worktree-repo-index'
import { compareWorktreeDisplayName } from '@/lib/worktree-display-name-order'
import { branchDisplayName } from '@/components/sidebar/WorktreeCardHelpers'
import { getCyclicProjectedWorktreeLineageIds } from '@/components/sidebar/worktree-lineage-projection'
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
import type { ExecutionHostId } from '../../../../shared/execution-host'

/** Single-line row: text-sm leading (20px) over py-2. Set as the row's explicit height. */
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

/**
 * Parent picker for the composer's Advanced drawer. Nesting only — the base
 * branch is unaffected.
 *
 * Everything that enumerates worktrees lives in the inner list, which Radix
 * mounts on open, so a closed picker costs one string selector and nothing else.
 */
function ComposerParentWorktreePickerImpl({
  repoId,
  executionHostId,
  projectId,
  value,
  onChange,
  disabled = false,
  activeFolderWorkspaceId = null
}: ComposerParentWorktreePickerProps): React.JSX.Element {
  // Why: subscribe so translate() copy refreshes on language change without a remount.
  useTranslation()
  const [open, setOpen] = useState(false)
  const labelId = `${useId()}label`

  // Why: an archived parent is already gone from the candidate list and the sidebar would
  // drop the edge, so showing its name would promise nesting the create can't deliver.
  const parentName = useAppStore((s) => {
    if (!value) {
      return null
    }
    const parent = getIndexedWorktreeById(s.worktreesByRepo, value)
    return parent && !parent.isArchived ? parent.displayName : null
  })

  // Why: the trigger goes inert when the Advanced drawer collapses, but the portaled
  // popover does not — it would linger detached from a control the user can't reach.
  // Adjusted during render (not in an effect) so the stale-open frame never paints.
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
          // Why: Radix would focus the content wrapper; the search box is the real target.
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
    // Why: the folder view drops archived and instance-stale rows, so accepting them here
    // would offer a parent whose whole branch the folder never actually shows.
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
  projectId,
  value,
  activeFolderWorkspaceId,
  onSelect
}: ParentWorktreeCandidateListProps): React.JSX.Element {
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const worktreeLineageById = useAppStore((s) => s.worktreeLineageById)
  const workspaceLineageByChildKey = useAppStore((s) => s.workspaceLineageByChildKey)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const imeEnter = useImeEnterGestureOwnership()
  const optionIdPrefix = `${useId()}option`
  const [search, setSearch] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)

  const candidates = useMemo(() => {
    // Why `?? undefined`: an unresolved host or project is "not known yet", not "no host", and
    // the boundary check reads undefined on either side as a wildcard. A candidate in this repo
    // with no recorded hostId inherits that repo's host, so it is on the child's host too.
    const childBoundary: WorktreeLineageBoundary = {
      repoId,
      hostId: executionHostId ?? undefined,
      projectId: projectId ?? undefined
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
          candidate.repoId === repoId &&
          !candidate.isArchived &&
          sharesWorktreeLineageBoundary(childBoundary, candidate) &&
          !cyclicLineageIds.has(candidate.id) &&
          (folderSubtreeIds === null || folderSubtreeIds.has(candidate.id))
      )
      .sort(compareWorktreeDisplayName)
  }, [
    activeFolderWorkspaceId,
    executionHostId,
    projectId,
    repoId,
    workspaceLineageByChildKey,
    worktreeLineageById,
    worktreesByRepo
  ])

  const filtered = useMemo(
    () => filterWorktreeParentCandidates(candidates, search),
    [candidates, search]
  )
  // Index 0 is the pinned "No parent" row; candidates start at 1.
  const activeIndex = clampWorktreeParentPickerIndex(highlightedIndex, filtered.length + 1)

  // Why: the "No parent" row is virtualized as index 0 rather than pinned above the
  // scroller. A row outside the virtual container shifts every item's true position
  // without the virtualizer knowing, so scrollToIndex would land short by that height.
  const virtualizer = useVirtualizer({
    count: filtered.length + 1,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => (index === 0 ? NO_PARENT_ROW_HEIGHT : PICKER_ROW_HEIGHT),
    overscan: PICKER_ROW_OVERSCAN,
    getItemKey: (index) => (index === 0 ? NO_PARENT_ROW_KEY : (filtered[index - 1]?.id ?? index)),
    // Why: the list mounts inside a popover that measures on the next frame, so
    // seed the viewport to avoid a blank first paint.
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
      // Why: re-ranking on each keystroke makes any prior highlight meaningless. A query
      // highlights the top match so Enter picks it; index 0 clears the parent, which is
      // never what typing a name means. The clamp drops it back to 0 when nothing matches.
      setSearch(nextSearch)
      setHighlightedIndex(nextSearch.trim().length > 0 ? 1 : 0)
      virtualizer.scrollToOffset(0)
    },
    [virtualizer]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      // Why: cmdk's root handler only knows the mounted virtual window, so own navigation here.
      // A CJK confirm sends two Enter keydowns and only the first is marked, so the marked-only
      // check must be paired with the gesture carry or the unmarked one commits a selection.
      if (imeEnter.ownsKeyDown(event) || isImeCompositionKeyDown(event)) {
        return
      }
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
    [activeIndex, filtered, imeEnter, moveHighlight, onSelect]
  )

  // Why: cmdk's Input owns aria-activedescendant and points it at its own empty
  // item registry while we drive selection, so re-point it after every commit.
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
        onKeyUp={imeEnter.onKeyUp}
        onCompositionStart={() => imeEnter.setComposing(true)}
        onCompositionEnd={() => imeEnter.setComposing(false)}
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
                      <span className="truncate">{branchDisplayName(candidate.branch)}</span>
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

/** Why: every prop is a primitive or a stable callback, so the composer's per-keystroke
 *  renders stop here instead of re-rendering the popover subtree. */
export const ComposerParentWorktreePicker = React.memo(ComposerParentWorktreePickerImpl)

export default ComposerParentWorktreePicker
