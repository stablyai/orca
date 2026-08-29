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
import { useWorktreeActivityStatuses } from './use-worktree-activity-statuses'
import { WorktreeParentPickerRow } from './WorktreeParentPickerRow'
import { getEligibleWorktreeParents } from './worktree-parent-candidates'
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
import { translate } from '@/i18n/i18n'

type WorktreeParentPickerPopoverProps = {
  open: boolean
  childWorktreeId: string | null
  anchorElement: HTMLElement | null
  onOpenChange: (open: boolean) => void
}

type AnchorRect = Pick<DOMRect, 'height' | 'left' | 'top' | 'width'>

type SelectParentArgs = {
  childWorktreeId: string | null
  parentWorktreeId: string
  assignWorktreeParent: (worktreeId: string, args: { parentWorktreeId: string }) => Promise<void>
  close: () => void
  showError: (message: string) => void
}

type WorktreeParentPickerKeyboardArgs = {
  event: React.KeyboardEvent<HTMLInputElement>
  candidates: readonly { id: string }[]
  activeIndex: number
  moveHighlight: (index: number) => void
  selectParent: (worktreeId: string) => void
}

function getAnchorRect(anchorElement: HTMLElement | null): AnchorRect | null {
  return anchorElement?.getBoundingClientRect() ?? null
}

const FOCUSABLE_ANCHOR_SELECTOR =
  'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])'

// Why: the anchor is a non-focusable `role="option"` row, so closing focus has
// to land on its nearest focusable container (the sidebar listbox).
export function getWorktreeParentPickerFocusRestoreTarget(
  anchorElement: HTMLElement | null
): HTMLElement | null {
  if (!anchorElement?.isConnected) {
    return null
  }
  return anchorElement.closest<HTMLElement>(FOCUSABLE_ANCHOR_SELECTOR)
}

export function selectWorktreeParent({
  childWorktreeId,
  parentWorktreeId,
  assignWorktreeParent,
  close,
  showError
}: SelectParentArgs): void {
  if (!childWorktreeId) {
    return
  }
  close()
  void assignWorktreeParent(childWorktreeId, { parentWorktreeId }).catch((error) => {
    console.error('Failed to set parent worktree:', error)
    showError(
      translate(
        'auto.components.sidebar.WorktreeParentPickerPopover.failedSetParent',
        'Failed to set parent worktree'
      )
    )
  })
}

export function handleWorktreeParentPickerKeyDown({
  event,
  candidates,
  activeIndex,
  moveHighlight,
  selectParent
}: WorktreeParentPickerKeyboardArgs): void {
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
      selectParent(candidate.id)
    }
  }
}

export function WorktreeParentPickerPopover({
  open,
  childWorktreeId,
  anchorElement,
  onOpenChange
}: WorktreeParentPickerPopoverProps): React.JSX.Element | null {
  const worktrees = useAllWorktrees()
  const worktreeMap = useWorktreeMap()
  const repoMap = useRepoMap()
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const lineageById = useAppStore((s) => s.worktreeLineageById)
  const assignWorktreeParent = useAppStore((s) => s.assignWorktreeParent)
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
  const child = childWorktreeId ? worktreeMap.get(childWorktreeId) : undefined
  const candidates = useMemo(
    () =>
      child
        ? getEligibleWorktreeParents({
            child,
            worktrees,
            lineageById,
            worktreeMap,
            repoMap
          })
        : [],
    [child, lineageById, repoMap, worktreeMap, worktrees]
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
    // Why: the click that selected the dropdown item can reach Radix's newly
    // mounted popover as an outside interaction before the picker settles.
    const timerId = window.setTimeout(() => {
      suppressInitialOutsideCloseRef.current = false
    }, 150)
    return () => window.clearTimeout(timerId)
  }, [open])

  const handleSelect = useCallback(
    (parentWorktreeId: string) => {
      selectWorktreeParent({
        childWorktreeId,
        parentWorktreeId,
        assignWorktreeParent,
        close: () => onOpenChange(false),
        showError: toast.error
      })
    },
    [assignWorktreeParent, childWorktreeId, onOpenChange]
  )

  // Why: a `position: fixed` anchor element would be laid out against the
  // sidebar's transformed virtual-row container, not the viewport, so its
  // viewport coordinates landed a full row-offset too low. A virtual anchor
  // renders no node and hands Radix the measured rect directly.
  const virtualAnchorRef = useMemo(() => {
    if (!anchorRect) {
      return undefined
    }
    const top = clampWorktreeParentPickerAnchorTop(
      anchorRect.top,
      // Why: measured from the full candidate list, not the filtered one, so
      // the popover does not jump around while the user types.
      estimateWorktreeParentPickerHeight(candidates.length),
      viewportHeight
    )
    const rect = new DOMRect(anchorRect.left, top, anchorRect.width, anchorRect.height)
    return { current: { getBoundingClientRect: () => rect } }
  }, [anchorRect, candidates.length, viewportHeight])

  const filtered = useMemo(
    () => filterWorktreeParentCandidates(candidates, search),
    [candidates, search]
  )
  const activeIndex = clampWorktreeParentPickerIndex(highlightedIndex, filtered.length)

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => PICKER_ROW_HEIGHT,
    overscan: PICKER_ROW_OVERSCAN,
    getItemKey: (index) => filtered[index]?.id ?? index,
    // Why: the list mounts inside a popover that measures on the next frame, so
    // seed the viewport with max-h-72 to avoid a blank first paint.
    initialRect: { width: 0, height: PICKER_LIST_MAX_HEIGHT }
  })
  const handleSearchChange = useCallback(
    (nextSearch: string) => {
      // Why: re-ranking on each keystroke makes any prior highlight meaningless.
      setSearch(nextSearch)
      setHighlightedIndex(0)
      virtualizer.scrollToOffset(0)
    },
    [virtualizer]
  )

  const virtualRows = virtualizer.getVirtualItems()
  // Why: the hook memoizes its store selector on this array's identity, so a
  // fresh array each render would rebuild the status map on every render.
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
      // Why: cmdk's root key handler navigates the items it has mounted, which
      // is only the virtual window here — own the navigation instead and keep
      // the event from reaching it.
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

  // Why: cmdk's Input owns aria-activedescendant and points it at its own item
  // registry, which is empty while we drive selection. Re-point it after every
  // commit so assistive tech still tracks the highlighted row.
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
    // Why: modal traps focus (incl. post-menu xterm restore); non-modal loses search focus.
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
        // Why: virtual anchor has no trigger for Radix to restore focus to, so
        // drive it back to the anchored row's listbox instead of dropping it on
        // the detached input (i.e. document.body).
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
          <span className="shrink-0">
            {translate(
              'auto.components.sidebar.WorktreeParentPickerPopover.setParentFor',
              'Set parent for'
            )}
          </span>
          <span className="truncate font-medium text-foreground">{child.displayName}</span>
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
                      key={candidate.id}
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
                      onClick={() => handleSelect(candidate.id)}
                    >
                      <WorktreeParentPickerRow
                        candidate={candidate}
                        repo={repoMap.get(candidate.repoId)}
                        status={statuses.get(candidate.id) ?? 'inactive'}
                        isCurrent={activeWorktreeId === candidate.id}
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
