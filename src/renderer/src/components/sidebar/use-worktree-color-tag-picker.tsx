import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import type { Worktree } from '../../../../shared/worktree/types'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  findKnownWorktreeById,
  findPinnedWorktreeRow
} from '@/store/slices/worktrees/listing/detected-worktree-meta'
import {
  getSharedWorkspaceColorTag,
  isMixedWorkspaceColorTagSelection
} from '../../../../shared/workspace-color-tag'
import { DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { WorktreeColorTagMenuItems } from './WorktreeColorTagMenuItems'
import { useWorkspaceColorTagPreviewsForWorktrees } from './workspace-color-tag-preview'
import { WorktreeColorTagPickerPopover } from './WorktreeColorTagPickerPopover'
import {
  CLOSE_ALL_CONTEXT_MENUS_EVENT,
  PARENT_PICKER_EXIT_ANIMATION_MS
} from './worktree-context-menu-policy'

// Why: the menu plays an exit animation, and Radix fires onCloseAutoFocus only once it finishes.
// A picker opened before that runs gets its focus yanked to the sidebar by the menu's own focus
// restore, and Radix dismisses the popover on focus-outside. This timer is only the fallback for
// a teardown that never fires onCloseAutoFocus; the normal path is the handoff below.
const CLOSE_AUTO_FOCUS_FALLBACK_MS = 250

type WorktreeColorTagPickerArgs = {
  /** The selection the menu is acting on — the live context set, not the clicked row alone. */
  contextWorktrees: readonly Worktree[]
  menuPoint: { x: number; y: number }
  /** Any selected workspace is deleting, so the row must not write into a half-failing batch. */
  disabled: boolean
  isMultiContext: boolean
  /** Resolves once the write has landed in the store, so the picker can hold its preview. */
  onAssignColorTag: (colorTag: string | null, targets: readonly Worktree[]) => Promise<void>
  /** The menu's own focus restore, run only when no picker is pending. */
  restoreMenuFocus: (event: Event) => void
  /** Tells the menu model a picker is pending or open, so its lifecycle does not complete under it. */
  onActiveChange: (active: boolean) => void
}

/**
 * The color-tag section of the workspace context menu: the swatch row that renders inside the
 * menu and the custom picker that renders beside it.
 *
 * Both come back already rendered. The picker must mount as a *sibling* of the menu — a Popover
 * inside `DropdownMenuContent` unmounts the moment the menu closes, which is exactly when the
 * picker needs to appear — and owning the row here keeps the view free of color-tag plumbing.
 */
export function useWorktreeColorTagPicker({
  contextWorktrees,
  menuPoint,
  disabled,
  isMultiContext,
  onAssignColorTag,
  restoreMenuFocus,
  onActiveChange
}: WorktreeColorTagPickerArgs): {
  sharedColorTag: string | null
  mixed: boolean
  openPicker: () => void
  handleMenuCloseAutoFocus: (event: Event) => void
  /** Swatch row plus its trailing separator; render inside `DropdownMenuContent`. */
  menuItems: React.JSX.Element
  picker: React.JSX.Element
} {
  const [open, setOpen] = useState(false)
  const openRef = useRef(false)
  // Why snapshot: the menu's selection only exists while the menu is open. Once it closes the
  // model falls back to the clicked row, and a folder row passes no selection at all, so the
  // picker would preview and commit a single workspace when the user right-clicked several.
  const [snapshot, setSnapshot] = useState<readonly Worktree[] | null>(null)
  const pendingRef = useRef(false)
  // Why: set when another menu superseded a pending handoff; the old menu's late close-auto-focus
  // then restores nothing, once, instead of focusing the sidebar under the new menu.
  const cancelledRef = useRef(false)
  const fallbackTimerRef = useRef<number | null>(null)
  const inactiveTimerRef = useRef<number | null>(null)
  const cancelledTimerRef = useRef<number | null>(null)

  const clearFallback = useCallback(() => {
    if (fallbackTimerRef.current != null) {
      window.clearTimeout(fallbackTimerRef.current)
      fallbackTimerRef.current = null
    }
  }, [])

  const flushPendingOpen = useCallback(() => {
    if (!pendingRef.current) {
      return
    }
    pendingRef.current = false
    clearFallback()
    setOpen(true)
  }, [clearFallback])

  const clearInactiveTimer = useCallback(() => {
    if (inactiveTimerRef.current != null) {
      window.clearTimeout(inactiveTimerRef.current)
      inactiveTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    openRef.current = open
  }, [open])

  // Why the timer: the superseded surface's close-auto-focus usually arrives within its exit
  // animation; if it never does, the flag must not skip a later, unrelated close's focus restore.
  const markSuperseded = useCallback(() => {
    cancelledRef.current = true
    if (cancelledTimerRef.current != null) {
      window.clearTimeout(cancelledTimerRef.current)
    }
    cancelledTimerRef.current = window.setTimeout(() => {
      cancelledTimerRef.current = null
      cancelledRef.current = false
    }, CLOSE_AUTO_FOCUS_FALLBACK_MS)
  }, [])

  // Why no restore: the menu that superseded this surface is open now, and focusing the sidebar
  // would be a focus-outside for it, dismissing it on arrival.
  const restoreFocusUnlessSuperseded = useCallback(
    (event: Event): void => {
      if (cancelledRef.current) {
        cancelledRef.current = false
        event.preventDefault()
        return
      }
      restoreMenuFocus(event)
    },
    [restoreMenuFocus]
  )

  useEffect(
    () => () => {
      clearFallback()
      clearInactiveTimer()
      if (cancelledTimerRef.current != null) {
        window.clearTimeout(cancelledTimerRef.current)
      }
    },
    [clearFallback, clearInactiveTimer]
  )

  const openPicker = useCallback(() => {
    setSnapshot(contextWorktrees)
    clearInactiveTimer()
    onActiveChange(true)
    pendingRef.current = true
    clearFallback()
    fallbackTimerRef.current = window.setTimeout(flushPendingOpen, CLOSE_AUTO_FOCUS_FALLBACK_MS)
  }, [clearFallback, clearInactiveTimer, contextWorktrees, flushPendingOpen, onActiveChange])

  const handleMenuCloseAutoFocus = useCallback(
    (event: Event): void => {
      if (!pendingRef.current) {
        restoreFocusUnlessSuperseded(event)
        return
      }
      // Why preventDefault and no focus restore: sending focus to the sidebar here is a
      // focus-outside for the popover about to open, which dismisses it on arrival.
      event.preventDefault()
      window.setTimeout(flushPendingOpen, 0)
    },
    [flushPendingOpen, restoreFocusUnlessSuperseded]
  )

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next)
      if (next) {
        return
      }
      setSnapshot(null)
      // Why hold: releasing the model the instant open flips would let an Agent Map host unmount
      // the popover mid exit animation; the parent picker holds its subtree for the same reason.
      clearInactiveTimer()
      inactiveTimerRef.current = window.setTimeout(() => {
        inactiveTimerRef.current = null
        onActiveChange(false)
      }, PARENT_PICKER_EXIT_ANIMATION_MS)
    },
    [clearInactiveTimer, onActiveChange]
  )

  // Why: a right-click on another card during this menu's exit animation opens a new menu and
  // broadcasts close-all, but the handoff would still open this picker over that menu with the old
  // selection as its targets. Superseded means cancelled. An already-open picker is cancelled too:
  // a keyboard or synthetic context-menu open has no pointer-down outside to dismiss the popover,
  // and Radix would otherwise commit the draft and restore focus under the new menu.
  useEffect(() => {
    const cancelSuperseded = (): void => {
      if (pendingRef.current) {
        pendingRef.current = false
        clearFallback()
        setSnapshot(null)
        clearInactiveTimer()
        onActiveChange(false)
        markSuperseded()
        return
      }
      if (openRef.current) {
        markSuperseded()
        handleOpenChange(false)
      }
    }
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, cancelSuperseded)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, cancelSuperseded)
  }, [clearFallback, clearInactiveTimer, handleOpenChange, markSuperseded, onActiveChange])

  // Why three sources: a write in flight shows on the card through the preview channel before the
  // store changes; once it lands the preview clears, but the menu's rows are a snapshot taken when
  // it opened, so the live store row is consulted before that frozen copy. The row's checked swatch,
  // its toggle, and the custom picker's seed all read what the card is showing, or an immediate undo
  // picks the wrong direction.
  const contextTags = useEffectiveColorTags(contextWorktrees)
  // Why: toggle-off keys off the whole selection, so unifying a mixed selection assigns
  // rather than clears.
  const sharedColorTag = useMemo(() => getSharedWorkspaceColorTag(contextTags), [contextTags])
  const mixed = useMemo(() => isMixedWorkspaceColorTagSelection(contextTags), [contextTags])

  const pickerTargets = snapshot ?? contextWorktrees
  const pickerTags = useEffectiveColorTags(pickerTargets)
  const pickerColorTag = useMemo(() => getSharedWorkspaceColorTag(pickerTags), [pickerTags])
  const commitPickerColorTag = useCallback(
    (colorTag: string | null) => onAssignColorTag(colorTag, pickerTargets),
    [onAssignColorTag, pickerTargets]
  )
  // Why: the row acts while the menu is open, so its targets are the live context selection.
  const assignFromRow = useCallback(
    (colorTag: string | null) => onAssignColorTag(colorTag, contextWorktrees),
    [contextWorktrees, onAssignColorTag]
  )

  return {
    sharedColorTag,
    mixed,
    openPicker,
    handleMenuCloseAutoFocus,
    menuItems: (
      <>
        <WorktreeColorTagMenuItems
          colorTag={sharedColorTag}
          mixed={mixed}
          disabled={disabled}
          isMultiContext={isMultiContext}
          onAssignColorTag={assignFromRow}
          onOpenCustomPicker={openPicker}
        />
        <DropdownMenuSeparator />
      </>
    ),
    picker: (
      <WorktreeColorTagPickerPopover
        open={open}
        colorTag={pickerColorTag}
        menuPoint={menuPoint}
        previewTargets={pickerTargets}
        onOpenChange={handleOpenChange}
        onCommitColorTag={commitPickerColorTag}
        onRestoreFocus={restoreFocusUnlessSuperseded}
      />
    )
  }
}

function liveColorTag(state: AppState, row: Worktree): string | null | undefined {
  // Why the guard: a host can mount the menu over a reduced store that carries no worktree
  // catalogs; the frozen row is then the best answer, not a crash in the finder.
  if (!state.worktreesByRepo || !state.detectedWorktreesByRepo || !state.folderWorkspaces) {
    return undefined
  }
  const match =
    findPinnedWorktreeRow(state, row.id, row.hostId, {
      identityKey: row.identity?.key,
      runtimeOwnerEnvironmentId: row.runtimeOwnerEnvironmentId ?? null
    }) ?? findKnownWorktreeById(state, row.id, row.hostId)
  return match ? (match.colorTag ?? null) : undefined
}

/** Preview if any, else the live store row, else the frozen menu row: what the card is showing. */
function useEffectiveColorTags(rows: readonly Worktree[]): readonly (string | null | undefined)[] {
  const previews = useWorkspaceColorTagPreviewsForWorktrees(rows)
  const live = useAppStore(useShallow((state) => rows.map((row) => liveColorTag(state, row))))
  return useMemo(
    () =>
      rows.map((row, index) => {
        const preview = previews[index]
        if (preview !== undefined) {
          return preview
        }
        const current = live[index]
        return current !== undefined ? current : row.colorTag
      }),
    [live, previews, rows]
  )
}
