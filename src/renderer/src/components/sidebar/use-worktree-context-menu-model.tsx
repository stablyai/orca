import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { useAllWorktrees, useRepoById, useRepoMap, useWorktreeMap } from '@/store/selectors'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  getCyclicProjectedWorktreeLineageIds,
  getLineageRenderInfo
} from './worktree-lineage-projection'
import { getWorkspaceStatus } from './workspace-status'
import { getEligibleWorktreeParents } from './worktree-parent-candidates'
import {
  hasSleepableWorkspaceActivity,
  useWorkspaceLineageMenuActions
} from './workspace-lineage-menu-actions'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getDeleteStateForWorktreeHost } from './worktree-delete-state-host-match'
import {
  CLOSE_ALL_CONTEXT_MENUS_EVENT,
  EMPTY_BROWSER_TABS_BY_WORKTREE,
  EMPTY_CYCLIC_LINEAGE_IDS,
  EMPTY_DELETE_STATE_BY_WORKTREE_ID,
  EMPTY_PTY_IDS_BY_TAB_ID,
  EMPTY_TABS_BY_WORKTREE,
  EMPTY_WORKSPACE_LINEAGE_BY_CHILD_KEY,
  EMPTY_WORKTREE_LINEAGE_BY_ID,
  hasWorktreeParentLink,
  isContextWorktreeDeletable,
  selectMenuScopedMap,
  shouldRemoveProjectFromContextMenu
} from './worktree-context-menu-policy'
import { useWorktreeContextMenuCommands } from './use-worktree-context-menu-commands'
import { useWorktreeParentPickerTransition } from './use-worktree-parent-picker-transition'
import { useWorktreeContextMenuSecondaryActions } from './use-worktree-context-menu-secondary-actions'

export type WorktreeContextMenuProps = {
  worktree: Worktree
  children: React.ReactNode
  contentClassName?: string
  selectedWorktrees?: readonly Worktree[]
  onContextMenuSelect?: (event: React.MouseEvent<HTMLElement>) => readonly Worktree[]
  onAssignWorkspaceStatus?: (worktreeIds: readonly string[], status: string) => void
  onOpenChange?: (open: boolean) => void
  onLifecycleComplete?: () => void
}

export function useWorktreeContextMenuModel({
  worktree,
  children,
  contentClassName,
  selectedWorktrees,
  onContextMenuSelect,
  onAssignWorkspaceStatus,
  onOpenChange,
  onLifecycleComplete
}: WorktreeContextMenuProps) {
  const defaultSelectedWorktrees = useMemo(() => [worktree], [worktree])
  const effectiveSelectedWorktrees = selectedWorktrees ?? defaultSelectedWorktrees
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const setWorktreesPinnedAndReveal = useAppStore((s) => s.setWorktreesPinnedAndReveal)
  const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)
  const openModal = useAppStore((s) => s.openModal)
  const projectGroups = useAppStore((s) => s.projectGroups)
  const createProjectGroup = useAppStore((s) => s.createProjectGroup)
  const moveProjectToGroup = useAppStore((s) => s.moveProjectToGroup)
  const repo = useRepoById(worktree.repoId)
  const deleteState = useAppStore((s) =>
    getDeleteStateForWorktreeHost(worktree, s.deleteStateByWorktreeId)
  )
  const [menuOpen, setMenuOpen] = useState(false)
  // Why: the Developer submenu is a power-user affordance, so it is revealed by
  // holding Option/Alt at right-click — captured at open time (like the Help
  // menu's admin options) so the submenu can't appear or vanish mid-menu and
  // shift the rows under the pointer.
  const [developerMenuRevealed, setDeveloperMenuRevealed] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })
  const [contextWorktrees, setContextWorktrees] = useState<readonly Worktree[]>(
    effectiveSelectedWorktrees
  )
  const [createGroupDialogOpen, setCreateGroupDialogOpen] = useState(false)
  const createGroupDialogActiveRef = useRef(false)
  const [parentPicker, setParentPicker] = useState<{
    childWorktreeId: string
    anchorElement: HTMLElement
  } | null>(null)
  const [parentPickerOpen, setParentPickerOpen] = useState(false)
  const pendingParentPickerRef = useRef<{
    childWorktreeId: string
    anchorElement: HTMLElement
  } | null>(null)
  const parentPickerFallbackTimerRef = useRef<number | null>(null)
  const parentPickerUnmountTimerRef = useRef<number | null>(null)
  const lifecycleStartedRef = useRef(false)
  const isDeleting = deleteState?.isDeleting ?? false
  const repoMap = useRepoMap()
  const worktreeMap = useWorktreeMap()
  const allWorktrees = useAllWorktrees()
  // Why: these maps feed only items rendered inside the OPEN dropdown, yet delete
  // teardown replaces them on every set(). Gate them behind menuOpen via stable
  // empty sentinels so the (common) closed wrapper stays inert to that churn. The
  // conditional lives INSIDE the selector so useAppStore is always called; the
  // inline arrow (not a useCallback) re-reads the live map synchronously on the
  // render where menuOpen flips true, so dependent useMemos recompute with real data.
  const worktreeLineageById = useAppStore((s) =>
    selectMenuScopedMap(menuOpen, s.worktreeLineageById, EMPTY_WORKTREE_LINEAGE_BY_ID)
  )
  const workspaceLineageByChildKey = useAppStore((s) =>
    selectMenuScopedMap(
      menuOpen,
      s.workspaceLineageByChildKey,
      EMPTY_WORKSPACE_LINEAGE_BY_CHILD_KEY
    )
  )
  const updateWorktreeLineage = useAppStore((s) => s.updateWorktreeLineage)
  const tabsByWorktree = useAppStore((s) =>
    selectMenuScopedMap(menuOpen, s.tabsByWorktree, EMPTY_TABS_BY_WORKTREE)
  )
  const ptyIdsByTabId = useAppStore((s) =>
    selectMenuScopedMap(menuOpen, s.ptyIdsByTabId, EMPTY_PTY_IDS_BY_TAB_ID)
  )
  const browserTabsByWorktree = useAppStore((s) =>
    selectMenuScopedMap(menuOpen, s.browserTabsByWorktree, EMPTY_BROWSER_TABS_BY_WORKTREE)
  )
  const deleteStateByWorktreeId = useAppStore((s) =>
    selectMenuScopedMap(menuOpen, s.deleteStateByWorktreeId, EMPTY_DELETE_STATE_BY_WORKTREE_ID)
  )
  const scopeRef = useRef<HTMLDivElement>(null)
  const contextMenuOpenedAtRef = useRef<number | null>(null)
  const activeContextWorktrees = menuOpen ? contextWorktrees : effectiveSelectedWorktrees
  const isMultiContext = activeContextWorktrees.length > 1
  const workspaceScope = parseWorkspaceKey(worktree.id)
  const folderWorkspaceId =
    workspaceScope?.type === 'folder' ? workspaceScope.folderWorkspaceId : null
  const sleepableWorktrees = useMemo(
    () =>
      activeContextWorktrees.filter((item) =>
        hasSleepableWorkspaceActivity(item.id, {
          tabsByWorktree,
          ptyIdsByTabId,
          browserTabsByWorktree
        })
      ),
    [activeContextWorktrees, browserTabsByWorktree, ptyIdsByTabId, tabsByWorktree]
  )
  const lineageMenuActions = useWorkspaceLineageMenuActions({
    enabled: !isMultiContext,
    parent: worktree,
    worktrees: allWorktrees,
    lineageById: worktreeLineageById,
    activity: { tabsByWorktree, ptyIdsByTabId, browserTabsByWorktree }
  })
  const lineageDescendantCount = lineageMenuActions.descendants.length
  const subtreeSleepableWorktrees = lineageMenuActions.sleepableTargets
  const deletingContext = useMemo(
    () =>
      activeContextWorktrees.some(
        (item) => getDeleteStateForWorktreeHost(item, deleteStateByWorktreeId)?.isDeleting
      ),
    [activeContextWorktrees, deleteStateByWorktreeId]
  )
  const deletingSubtree = lineageMenuActions.targets.some(
    (item) => getDeleteStateForWorktreeHost(item, deleteStateByWorktreeId)?.isDeleting
  )
  const contextDeletePending = isMultiContext ? deletingContext : deletingSubtree
  const contextWorkspaceStatus = useMemo(() => {
    const [first, ...rest] = activeContextWorktrees
    if (!first) {
      return ''
    }
    const status = getWorkspaceStatus(first, workspaceStatuses)
    return rest.every((item) => getWorkspaceStatus(item, workspaceStatuses) === status)
      ? status
      : ''
  }, [activeContextWorktrees, workspaceStatuses])
  const batchDeleteWorktrees = useMemo(
    () =>
      activeContextWorktrees.filter((item) => {
        const itemRepo = repoMap.get(item.repoId)
        return isContextWorktreeDeletable(item, itemRepo)
      }),
    [activeContextWorktrees, repoMap]
  )
  const removesProject = shouldRemoveProjectFromContextMenu(repo, worktree)
  const sleepLabel =
    isMultiContext && sleepableWorktrees.length > 0
      ? `Sleep ${sleepableWorktrees.length} Workspace${sleepableWorktrees.length === 1 ? '' : 's'}`
      : 'Sleep'
  const deleteLabel =
    isMultiContext && batchDeleteWorktrees.length > 0
      ? `Delete ${batchDeleteWorktrees.length} Workspace${batchDeleteWorktrees.length === 1 ? '' : 's'}`
      : 'Delete Selected'
  const hasParentLink = hasWorktreeParentLink(
    worktree,
    worktreeLineageById,
    workspaceLineageByChildKey
  )
  const cyclicLineageIds = useMemo(
    () =>
      menuOpen
        ? getCyclicProjectedWorktreeLineageIds(worktreeLineageById, worktreeMap)
        : EMPTY_CYCLIC_LINEAGE_IDS,
    [menuOpen, worktreeLineageById, worktreeMap]
  )
  // Why: path-derived worktree IDs can be reused. The menu must honor the same
  // instance check as grouped rows before offering navigation to a parent.
  const lineageInfo = useMemo(
    () => getLineageRenderInfo(worktree, worktreeLineageById, worktreeMap, cyclicLineageIds),
    [cyclicLineageIds, worktree, worktreeLineageById, worktreeMap]
  )
  const validParentWorktreeId = lineageInfo.state === 'valid' ? lineageInfo.parent.id : null
  const hasAnyContextLineage = activeContextWorktrees.some((item) =>
    hasWorktreeParentLink(item, worktreeLineageById, workspaceLineageByChildKey)
  )
  const eligibleParentCount = useMemo(
    () =>
      menuOpen
        ? getEligibleWorktreeParents({
            child: worktree,
            worktrees: allWorktrees,
            lineageById: worktreeLineageById,
            worktreeMap,
            repoMap,
            cyclicLineageIds
          }).length
        : 0,
    [allWorktrees, cyclicLineageIds, menuOpen, repoMap, worktree, worktreeLineageById, worktreeMap]
  )

  const setMenuOpenState = useCallback(
    (open: boolean) => {
      setMenuOpen(open)
      if (!open) {
        // Why: the reveal is per-open, so a later plain right-click can't inherit it.
        setDeveloperMenuRevealed(false)
      }
      onOpenChange?.(open)
    },
    [onOpenChange]
  )

  useEffect(() => {
    if (!onLifecycleComplete) {
      return
    }
    if (menuOpen) {
      lifecycleStartedRef.current = true
    }
    if (
      !lifecycleStartedRef.current ||
      menuOpen ||
      createGroupDialogOpen ||
      createGroupDialogActiveRef.current ||
      parentPicker !== null ||
      pendingParentPickerRef.current !== null
    ) {
      return
    }
    const timer = window.setTimeout(() => {
      if (createGroupDialogActiveRef.current || pendingParentPickerRef.current !== null) {
        return
      }
      lifecycleStartedRef.current = false
      onLifecycleComplete?.()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [createGroupDialogOpen, menuOpen, onLifecycleComplete, parentPicker])

  useEffect(() => {
    const closeMenu = (): void => setMenuOpenState(false)
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
  }, [setMenuOpenState])

  useEffect(
    () => () => {
      if (parentPickerFallbackTimerRef.current != null) {
        window.clearTimeout(parentPickerFallbackTimerRef.current)
      }
      if (parentPickerUnmountTimerRef.current != null) {
        window.clearTimeout(parentPickerUnmountTimerRef.current)
      }
    },
    []
  )

  const {
    handleAssignWorkspaceStatus,
    handleCloseTerminals,
    handleCopyPath,
    handleCreateGroupDialogOpenChange,
    handleCreateGroupFromRepo,
    handleDelete,
    handleMoveProjectToGroup,
    handleOpenParent,
    handleRemoveProjectFromGroup,
    handleRename,
    handleSleepSubtree,
    handleSubmitNewProjectGroup,
    handleTogglePin,
    handleToggleRead
  } = useWorktreeContextMenuCommands({
    activeContextWorktrees,
    batchDeleteWorktrees,
    createGroupDialogActiveRef,
    createProjectGroup,
    folderWorkspaceId,
    isMultiContext,
    moveProjectToGroup,
    onAssignWorkspaceStatus,
    openModal,
    repo,
    scopeRef,
    setCreateGroupDialogOpen,
    setMenuOpenState,
    setWorktreesPinnedAndReveal,
    sleepableWorktrees,
    subtreeSleepableWorktrees,
    updateWorktreeMeta,
    validParentWorktreeId,
    worktree,
    workspaceStatuses
  })
  const { handleOpenParentPicker, handleParentPickerOpenChange, openPendingParentPicker } =
    useWorktreeParentPickerTransition({
      fallbackTimerRef: parentPickerFallbackTimerRef,
      pendingRef: pendingParentPickerRef,
      scopeRef,
      setMenuOpenState,
      setParentPicker,
      setParentPickerOpen,
      unmountTimerRef: parentPickerUnmountTimerRef,
      worktreeId: worktree.id
    })
  const { handleRemoveParentLink, suppressOpeningPointerEvent } =
    useWorktreeContextMenuSecondaryActions({
      activeContextWorktrees,
      contextMenuOpenedAtRef,
      updateWorktreeLineage
    })

  const handleCloseAutoFocus = useCallback(
    (event: Event) => {
      // Why: Radix otherwise restores focus to the hidden context-menu trigger.
      // When Sleep/Delete clears the active workspace and remounts the sidebar,
      // that focus restore can scroll the virtual list away from the row the
      // user just acted on.
      event.preventDefault()
      if (pendingParentPickerRef.current) {
        window.setTimeout(openPendingParentPicker, 0)
        return
      }
      const sidebar = scopeRef.current?.closest('[data-worktree-sidebar]')
      if (sidebar instanceof HTMLElement) {
        sidebar.focus({ preventScroll: true })
      }
    },
    [openPendingParentPicker]
  )

  return {
    activeContextWorktrees,
    allWorktrees,
    batchDeleteWorktrees,
    browserTabsByWorktree,
    children,
    contentClassName,
    contextDeletePending,
    contextMenuOpenedAtRef,
    contextWorkspaceStatus,
    createGroupDialogOpen,
    cyclicLineageIds,
    deleteLabel,
    deletingContext,
    deletingSubtree,
    developerMenuRevealed,
    eligibleParentCount,
    effectiveSelectedWorktrees,
    folderWorkspaceId,
    handleAssignWorkspaceStatus,
    handleCloseAutoFocus,
    handleCloseTerminals,
    handleCopyPath,
    handleCreateGroupDialogOpenChange,
    handleCreateGroupFromRepo,
    handleDelete,
    handleMoveProjectToGroup,
    handleOpenParent,
    handleOpenParentPicker,
    handleParentPickerOpenChange,
    handleRemoveParentLink,
    handleRemoveProjectFromGroup,
    handleRename,
    handleSleepSubtree,
    handleSubmitNewProjectGroup,
    handleTogglePin,
    handleToggleRead,
    hasAnyContextLineage,
    hasParentLink,
    isDeleting,
    isMultiContext,
    lineageDescendantCount,
    menuOpen,
    menuPoint,
    onContextMenuSelect,
    parentPicker,
    parentPickerOpen,
    projectGroups,
    ptyIdsByTabId,
    removesProject,
    repo,
    scopeRef,
    setContextWorktrees,
    setDeveloperMenuRevealed,
    setMenuOpenState,
    setMenuPoint,
    sleepLabel,
    sleepableWorktrees,
    subtreeSleepableWorktrees,
    suppressOpeningPointerEvent,
    tabsByWorktree,
    validParentWorktreeId,
    worktree,
    workspaceStatuses
  }
}

export type WorktreeContextMenuModel = ReturnType<typeof useWorktreeContextMenuModel>
