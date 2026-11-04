import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { toast } from 'sonner'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Command, CommandInput, CommandList } from '@/components/ui/command'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useAppStore } from '@/store'
import { useAllWorktrees, useRepoMap, useWorktreeMap } from '@/store/selectors'
import { cn } from '@/lib/utils'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import { useWorktreeActivityStatuses } from '../../workspace-card/activity/use-worktree-activity-statuses'
import { WorktreeParentPickerRow } from './WorktreeParentPickerRow'
import { getEligibleWorktreeParents } from './worktree-parent-candidates'
import { selectSidebarLineageParentIdentities } from '@/store/cross-store-lineage-parents'
import { isCrossStoreParent } from '@/store/slices/worktrees/metadata/cross-store-parent-ref'
import { useParentMachineLabel } from './use-parent-machine-label'
import { selectWorktreeParent } from './worktree-parent-selection'

export { selectWorktreeParent }
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  clampWorktreeParentPickerIndex,
  filterWorktreeParentCandidates
} from './worktree-parent-picker-filtering'
import {
  clampWorktreeParentPickerAnchorTop,
  estimateWorktreeParentPickerHeight,
  PICKER_ROW_HEIGHT,
  PICKER_ROW_OVERSCAN,
  PICKER_LIST_MAX_HEIGHT,
  PICKER_VIEWPORT_PADDING
} from './worktree-parent-picker-placement'
import { Trans } from 'react-i18next'
import { i18n, translate } from '@/i18n/i18n'

type WorktreeParentPickerPopoverProps = {
  open: boolean
  /** The row the menu was opened on; its host picks it out from a same-id twin. */
  clickedChild: Worktree | null
  anchorElement: HTMLElement | null
  onOpenChange: (open: boolean) => void
}

type AnchorRect = Pick<DOMRect, 'height' | 'left' | 'top' | 'width'>

type WorktreeParentPickerKeyboardArgs<Candidate> = {
  event: React.KeyboardEvent<HTMLInputElement>
  candidates: readonly Candidate[]
  activeIndex: number
  moveHighlight: (index: number) => void
  selectParent: (candidate: Candidate) => void
}

function getAnchorRect(anchorElement: HTMLElement | null): AnchorRect | null {
  return anchorElement?.getBoundingClientRect() ?? null
}

const FOCUSABLE_ANCHOR_SELECTOR =
  'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])'

// Option-row anchors cannot take focus; restore it to their enclosing sidebar listbox.
export function getWorktreeParentPickerFocusRestoreTarget(
  anchorElement: HTMLElement | null
): HTMLElement | null {
  if (!anchorElement?.isConnected) {
    return null
  }
  return anchorElement.closest<HTMLElement>(FOCUSABLE_ANCHOR_SELECTOR)
}

export function handleWorktreeParentPickerKeyDown<Candidate>({
  event,
  candidates,
  activeIndex,
  moveHighlight,
  selectParent
}: WorktreeParentPickerKeyboardArgs<Candidate>): void {
  if (isImeCompositionKeyDown(event) || candidates.length === 0) {
    return
  }
  const navigate = (nextIndex: number): void => {
    event.preventDefault()
    event.stopPropagation()
    moveHighlight(clampWorktreeParentPickerIndex(nextIndex, candidates.length))
  }
  if (event.key === 'ArrowDown') {
    navigate(activeIndex + 1)
  } else if (event.key === 'ArrowUp') {
    navigate(activeIndex - 1)
  } else if (event.key === 'Home') {
    navigate(0)
  } else if (event.key === 'End') {
    navigate(candidates.length - 1)
  } else if (event.key === 'Enter') {
    const candidate = candidates[activeIndex]
    if (candidate) {
      event.preventDefault()
      event.stopPropagation()
      selectParent(candidate)
    }
  }
}

export function WorktreeParentPickerPopover({
  open,
  clickedChild,
  anchorElement,
  onOpenChange
}: WorktreeParentPickerPopoverProps): React.JSX.Element | null {
  const worktrees = useAllWorktrees()
  const worktreeMap = useWorktreeMap()
  const repoMap = useRepoMap()
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const lineageById = useAppStore((s) => s.worktreeLineageById)
  const assignWorktreeParent = useAppStore((s) => s.assignWorktreeParent)
  const assignCrossStoreWorktreeParent = useAppStore((s) => s.assignCrossStoreWorktreeParent)
  const parentIdentities = useAppStore(selectSidebarLineageParentIdentities)
  const suppressInitialOutsideCloseRef = useRef(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const optionIdPrefix = `${useId()}option`
  const [search, setSearch] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const [anchorRect, setAnchorRect] = useState<AnchorRect | null>(() =>
    getAnchorRect(anchorElement)
  )
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight)
  const child = useMemo(() => {
    const identity = clickedChild ? getWorktreeHostIdentity(clickedChild) : null
    return identity ? worktrees.find((row) => getWorktreeHostIdentity(row) === identity) : undefined
  }, [clickedChild, worktrees])
  const candidates = useMemo(
    () =>
      child
        ? getEligibleWorktreeParents({
            child,
            worktrees,
            lineageById,
            worktreeMap,
            repoMap,
            parentIdentities
          })
        : [],
    [child, lineageById, parentIdentities, repoMap, worktreeMap, worktrees]
  )

  useLayoutEffect(() => {
    if (!open) {
      return
    }
    const updateAnchorRect = (): void => {
      setAnchorRect(getAnchorRect(anchorElement))
      setViewportHeight(window.innerHeight)
    }
    updateAnchorRect()
    window.addEventListener('resize', updateAnchorRect)
    window.addEventListener('scroll', updateAnchorRect, true)
    return () => {
      window.removeEventListener('resize', updateAnchorRect)
      window.removeEventListener('scroll', updateAnchorRect, true)
    }
  }, [anchorElement, open])

  useEffect(() => {
    if (!open) {
      suppressInitialOutsideCloseRef.current = false
      return
    }
    suppressInitialOutsideCloseRef.current = true
    // The selecting menu click can reach the just-mounted popover as an outside interaction; suppress it briefly.
    const timerId = window.setTimeout(() => {
      suppressInitialOutsideCloseRef.current = false
    }, 150)
    return () => window.clearTimeout(timerId)
  }, [open])

  const machineLabelOf = useParentMachineLabel(
    useCallback((candidate: Worktree) => !!child && isCrossStoreParent(child, candidate), [child])
  )

  const handleSelect = useCallback(
    (candidate: Worktree) => {
      if (child && isCrossStoreParent(child, candidate)) {
        onOpenChange(false)
        // Refusals here (older Orca, a loop on the parent's machine) name what to do next.
        void assignCrossStoreWorktreeParent(child, candidate).catch((error: unknown) => {
          toast.error(
            translate(
              'auto.components.sidebar.WorktreeParentPickerPopover.failedSetParent',
              'Failed to set parent worktree'
            ),
            { description: error instanceof Error ? error.message : undefined }
          )
        })
        return
      }
      selectWorktreeParent({
        childWorktreeId: child?.id ?? null,
        childHostId: child?.hostId,
        parentWorktreeId: candidate.id,
        assignWorktreeParent,
        close: () => onOpenChange(false),
        showError: toast.error
      })
    },
    [assignCrossStoreWorktreeParent, assignWorktreeParent, child, onOpenChange]
  )

  // Transformed virtual rows offset fixed DOM anchors; pass viewport bounds through a node-free virtual anchor.
  const virtualAnchorRef = useMemo(() => {
    if (!anchorRect) {
      return undefined
    }
    const top = clampWorktreeParentPickerAnchorTop(
      anchorRect.top,
      // Use unfiltered candidate count so the popover does not jump while typing.
      estimateWorktreeParentPickerHeight(candidates.length),
      viewportHeight
    )
    const rect = new DOMRect(anchorRect.left, top, anchorRect.width, anchorRect.height)
    return { current: { getBoundingClientRect: () => rect } }
  }, [anchorRect, candidates.length, viewportHeight])

  const filtered = useMemo(
    () => filterWorktreeParentCandidates(candidates, search, repoMap),
    [candidates, search, repoMap]
  )
  const activeIndex = clampWorktreeParentPickerIndex(highlightedIndex, filtered.length)

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => PICKER_ROW_HEIGHT,
    overscan: PICKER_ROW_OVERSCAN,
    getItemKey: (index) => (filtered[index] ? getWorktreeHostIdentity(filtered[index]) : index),
    // Seed viewport height because the popover measures next frame and would otherwise paint blank.
    initialRect: { width: 0, height: PICKER_LIST_MAX_HEIGHT }
  })
  const handleSearchChange = useCallback(
    (nextSearch: string) => {
      setSearch(nextSearch)
      setHighlightedIndex(0)
      virtualizer.scrollToOffset(0)
    },
    [virtualizer]
  )

  const virtualRows = virtualizer.getVirtualItems()
  // Keep this ID array stable because the status selector memoizes by its identity.
  const visibleWorktreeIds = useMemo(
    () =>
      virtualRows
        .map((row) => filtered[row.index]?.id)
        .filter((id): id is string => id !== undefined),
    [filtered, virtualRows]
  )
  const statuses = useWorktreeActivityStatuses(visibleWorktreeIds)

  const moveHighlight = useCallback(
    (nextIndex: number) => {
      setHighlightedIndex(nextIndex)
      virtualizer.scrollToIndex(nextIndex, { align: 'auto' })
    },
    [virtualizer]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      // Own navigation across the full candidate set; cmdk sees only mounted virtual rows.
      handleWorktreeParentPickerKeyDown({
        event,
        candidates: filtered,
        activeIndex,
        moveHighlight,
        selectParent: handleSelect
      })
    },
    [activeIndex, filtered, handleSelect, moveHighlight]
  )

  // Override cmdk’s empty item registry after commit so aria-activedescendant follows our virtual selection.
  useEffect(() => {
    const input = inputRef.current
    if (!input) {
      return
    }
    const activeOptionId = filtered.length > 0 ? `${optionIdPrefix}-${activeIndex}` : null
    if (activeOptionId) {
      input.setAttribute('aria-activedescendant', activeOptionId)
    } else {
      input.removeAttribute('aria-activedescendant')
    }
  })

  if (!child || !anchorRect) {
    return null
  }

  return (
    // Modal focus trapping prevents post-menu xterm restoration from stealing search focus.
    <Popover modal open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={virtualAnchorRef} />
      <PopoverContent
        align="start"
        side="right"
        sideOffset={8}
        collisionPadding={PICKER_VIEWPORT_PADDING}
        className="flex max-h-(--radix-popover-content-available-height) w-80 flex-col p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
        }}
        // Virtual anchors have no trigger to restore; return focus to the anchored row’s listbox.
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          getWorktreeParentPickerFocusRestoreTarget(anchorElement)?.focus()
        }}
        onInteractOutside={(event) => {
          if (suppressInitialOutsideCloseRef.current) {
            event.preventDefault()
          }
        }}
      >
        <div className="flex min-w-0 shrink-0 items-center gap-1.5 border-b border-border bg-muted/30 px-3 py-2 text-[11px] leading-none text-muted-foreground">
          <span className="min-w-0 truncate">
            <Trans
              i18n={i18n}
              defaults={translate(
                'auto.components.sidebar.WorktreeParentPickerPopover.setParentForName',
                'Set parent for <name>{{name}}</name>'
              )}
              values={{ name: child.displayName }}
              components={{ name: <span className="font-medium text-foreground" /> }}
            />
          </span>
        </div>
        <Command shouldFilter={false} className="min-h-0">
          <CommandInput
            ref={inputRef}
            value={search}
            onValueChange={handleSearchChange}
            onKeyDown={handleKeyDown}
            wrapperClassName="shrink-0"
            placeholder={translate(
              'auto.components.sidebar.WorktreeParentPickerPopover.searchPlaceholder',
              'Search worktrees...'
            )}
          />
          <CommandList ref={listRef} className="max-h-72 min-h-0 flex-1">
            {filtered.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                {translate(
                  'auto.components.sidebar.WorktreeParentPickerPopover.empty',
                  'No matching eligible worktrees.'
                )}
              </div>
            ) : (
              <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                {virtualRows.map((virtualRow) => {
                  const candidate = filtered[virtualRow.index]
                  if (!candidate) {
                    return null
                  }
                  const isHighlighted = virtualRow.index === activeIndex
                  return (
                    <div
                      key={getWorktreeHostIdentity(candidate)}
                      id={`${optionIdPrefix}-${virtualRow.index}`}
                      role="option"
                      aria-selected={isHighlighted}
                      data-selected={isHighlighted || undefined}
                      className={cn(
                        'absolute left-0 top-0 flex w-full cursor-default select-none items-start gap-2 overflow-hidden rounded-sm px-2 py-2 text-sm outline-none',
                        isHighlighted && 'bg-accent text-accent-foreground'
                      )}
                      style={{
                        height: virtualRow.size,
                        transform: `translateY(${virtualRow.start}px)`
                      }}
                      onPointerMove={() => setHighlightedIndex(virtualRow.index)}
                      onClick={() => handleSelect(candidate)}
                    >
                      <WorktreeParentPickerRow
                        candidate={candidate}
                        repo={repoMap.get(candidate.repoId)}
                        status={statuses.get(candidate.id) ?? 'inactive'}
                        isCurrent={activeWorktreeId === candidate.id}
                        machineLabel={machineLabelOf(candidate)}
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
