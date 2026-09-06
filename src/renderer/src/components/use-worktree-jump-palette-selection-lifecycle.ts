import { useCallback, useEffect, useLayoutEffect } from 'react'
import {
  ORCA_BROWSER_FOCUS_REQUEST_EVENT,
  queueBrowserFocusRequest
} from '@/components/browser-pane/host-guest/browser-focus'
import { captureCmdJActiveGroupSnapshot } from '@/components/cmd-j/quick-action-context'
import { EMPTY_PALETTE_FILTER } from '@/components/cmd-j/palette-filter'
import { resolvePaletteFocusRestoreTarget } from '@/components/cmd-j/palette-focus-restore-target'
import {
  CREATE_WORKTREE_ITEM_ID,
  getNextWorktreePaletteSelection
} from '@/lib/worktree-palette-create-action'
import { useAppStore } from '@/store'
import { CREATE_WORKSPACE_QUICK_ACTION_ITEM_ID } from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteListEntries } from './use-worktree-jump-palette-list-entries'
import type { WorktreeJumpPaletteLocalState } from './use-worktree-jump-palette-local-state'
import type { WorktreeJumpPaletteOpenTabs } from './use-worktree-jump-palette-open-tabs'
import type { WorktreeJumpPaletteProjectTargets } from './use-worktree-jump-palette-project-targets'
import type { WorktreeJumpPaletteQuickActions } from './use-worktree-jump-palette-quick-actions'
import type { WorktreeJumpPaletteSections } from './use-worktree-jump-palette-sections'
import type { WorktreeJumpPaletteStoreState } from './use-worktree-jump-palette-store-state'
import type { WorktreeJumpPaletteWorktrees } from './use-worktree-jump-palette-worktrees'

type WorktreeJumpPaletteSelectionLifecycleInput = WorktreeJumpPaletteStoreState &
  WorktreeJumpPaletteLocalState &
  WorktreeJumpPaletteOpenTabs &
  WorktreeJumpPaletteProjectTargets &
  WorktreeJumpPaletteQuickActions &
  WorktreeJumpPaletteSections &
  WorktreeJumpPaletteListEntries &
  WorktreeJumpPaletteWorktrees

export function useWorktreeJumpPaletteSelectionLifecycle({
  visibleWorktreesForState,
  hasQuery,
  searchScopeWorktrees,
  browserPageEntries,
  simulatorTabEntries,
  workspaceTabEntries,
  middleItems,
  visible,
  wasVisibleRef,
  recordFeatureInteraction,
  createLookupGuard,
  activeGroupSnapshotRef,
  activeWorktreeId,
  previousWorktreeIdRef,
  activeTabType,
  previousActiveTabTypeRef,
  browserTabsByWorktree,
  activeBrowserTabId,
  previousBrowserPageIdRef,
  previousBrowserFocusTargetRef,
  previousFocusElementRef,
  skipRestoreFocusRef,
  latestQueryRef,
  setQuery,
  setSelectedItemId,
  setRawFilter,
  selectionMovedByUserRef,
  taskSourceUrl,
  listRef,
  preserveCreateLookupOnCloseRef,
  selectedItemId,
  selectionItemIds,
  showCreateAction,
  deferredQuery,
  prefetchCreateWorkspaceBaseForComposer,
  fallbackFocusOuterFrameRef,
  fallbackFocusInnerFrameRef,
  closeModal
}: WorktreeJumpPaletteSelectionLifecycleInput) {
  const hasAnyWorktrees = visibleWorktreesForState.length > 0
  const hasAnySearchableWorktrees = hasQuery ? searchScopeWorktrees.length > 0 : hasAnyWorktrees
  const hasAnyOpenTabs =
    browserPageEntries.length > 0 ||
    simulatorTabEntries.length > 0 ||
    workspaceTabEntries.length > 0
  const hasAnyMiddleResults = middleItems.length > 0
  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      recordFeatureInteraction('cmd-j')
      createLookupGuard.invalidate()
      activeGroupSnapshotRef.current = captureCmdJActiveGroupSnapshot(
        useAppStore.getState(),
        activeWorktreeId
      )
      previousWorktreeIdRef.current = activeWorktreeId
      previousActiveTabTypeRef.current = activeTabType
      previousBrowserPageIdRef.current =
        activeWorktreeId && activeTabType === 'browser'
          ? ((browserTabsByWorktree[activeWorktreeId] ?? []).find(
              (workspace) => workspace.id === activeBrowserTabId
            )?.activePageId ?? null)
          : null
      previousBrowserFocusTargetRef.current =
        activeTabType === 'browser' &&
        document.activeElement instanceof HTMLElement &&
        document.activeElement.closest('[data-orca-browser-address-bar="true"]')
          ? 'address-bar'
          : 'webview'
      previousFocusElementRef.current =
        document.activeElement instanceof HTMLElement && document.activeElement !== document.body
          ? document.activeElement
          : null
      skipRestoreFocusRef.current = false
      latestQueryRef.current = ''
      setQuery('')
      setSelectedItemId('')
      selectionMovedByUserRef.current = false
      setRawFilter(EMPTY_PALETTE_FILTER)
      listRef.current?.scrollTo(0, 0)
    }
    if (!visible && wasVisibleRef.current) {
      if (preserveCreateLookupOnCloseRef.current) {
        preserveCreateLookupOnCloseRef.current = false
      } else {
        createLookupGuard.invalidate()
      }
      activeGroupSnapshotRef.current = null
    }
    wasVisibleRef.current = visible
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs and state setters are stable.
  }, [
    activeBrowserTabId,
    activeTabType,
    activeWorktreeId,
    browserTabsByWorktree,
    createLookupGuard,
    recordFeatureInteraction,
    visible
  ])
  const commandSelectedItemId = getNextWorktreePaletteSelection({
    currentSelectedItemId: selectedItemId,
    queryChanged: false,
    selectableItemIds: selectionItemIds,
    showCreateAction,
    autoSelectCreateAction: taskSourceUrl !== null
  })
  const handleCommandSelectionChange = useCallback(
    (nextItemId: string) => {
      setSelectedItemId(nextItemId)
    },
    [setSelectedItemId]
  )
  // A late cmdk callback can restore the old cursor after handleQueryChange clears it.
  // Commit the new list head explicitly when the deferred query changes.
  useLayoutEffect(() => {
    setSelectedItemId(
      getNextWorktreePaletteSelection({
        currentSelectedItemId: '',
        queryChanged: true,
        selectableItemIds: selectionItemIds,
        showCreateAction,
        autoSelectCreateAction: taskSourceUrl !== null
      })
    )
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- selection resets only when the deferred query commits.
  }, [deferredQuery])
  useEffect(() => {
    const isCreateWorkspaceHighlighted =
      commandSelectedItemId === CREATE_WORKTREE_ITEM_ID ||
      commandSelectedItemId === CREATE_WORKSPACE_QUICK_ACTION_ITEM_ID
    if (!visible || !isCreateWorkspaceHighlighted) {
      return
    }
    prefetchCreateWorkspaceBaseForComposer()
  }, [commandSelectedItemId, prefetchCreateWorkspaceBaseForComposer, visible])
  const handleQueryChange = useCallback(
    (nextQuery: string) => {
      latestQueryRef.current = nextQuery
      setQuery(nextQuery)
      setSelectedItemId('')
      listRef.current?.scrollTo(0, 0)
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs and setters preserve their original stable identities.
    []
  )
  const cancelFallbackFocusFrames = useCallback((): void => {
    if (fallbackFocusOuterFrameRef.current !== null) {
      cancelAnimationFrame(fallbackFocusOuterFrameRef.current)
      fallbackFocusOuterFrameRef.current = null
    }
    if (fallbackFocusInnerFrameRef.current !== null) {
      cancelAnimationFrame(fallbackFocusInnerFrameRef.current)
      fallbackFocusInnerFrameRef.current = null
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs preserve their original stable identities.
  }, [])
  useEffect(() => cancelFallbackFocusFrames, [cancelFallbackFocusFrames])
  const focusFallbackSurface = useCallback(
    (preferredTarget?: HTMLElement | null) => {
      cancelFallbackFocusFrames()
      fallbackFocusOuterFrameRef.current = requestAnimationFrame(() => {
        fallbackFocusOuterFrameRef.current = null
        fallbackFocusInnerFrameRef.current = requestAnimationFrame(() => {
          fallbackFocusInnerFrameRef.current = null
          resolvePaletteFocusRestoreTarget(preferredTarget ?? null)?.focus({ preventScroll: true })
        })
      })
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs preserve their original stable identities.
    [cancelFallbackFocusFrames]
  )
  const requestBrowserFocus = useCallback(
    (detail: { pageId: string; target: 'webview' | 'address-bar' }) => {
      queueBrowserFocusRequest(detail)
      window.dispatchEvent(new CustomEvent(ORCA_BROWSER_FOCUS_REQUEST_EVENT, { detail }))
    },
    []
  )
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        return
      }
      closeModal()
      if (skipRestoreFocusRef.current) {
        return
      }
      if (previousActiveTabTypeRef.current === 'browser' && previousBrowserPageIdRef.current) {
        requestBrowserFocus({
          pageId: previousBrowserPageIdRef.current,
          target: previousBrowserFocusTargetRef.current
        })
        return
      }
      if (previousWorktreeIdRef.current) {
        focusFallbackSurface(previousFocusElementRef.current)
      }
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs preserve their original stable identities.
    [closeModal, focusFallbackSurface, requestBrowserFocus]
  )
  return {
    hasAnyWorktrees,
    hasAnySearchableWorktrees,
    hasAnyOpenTabs,
    hasAnyMiddleResults,
    commandSelectedItemId,
    handleCommandSelectionChange,
    handleQueryChange,
    focusFallbackSurface,
    requestBrowserFocus,
    handleOpenChange
  }
}

export type WorktreeJumpPaletteSelectionLifecycle = ReturnType<
  typeof useWorktreeJumpPaletteSelectionLifecycle
>
