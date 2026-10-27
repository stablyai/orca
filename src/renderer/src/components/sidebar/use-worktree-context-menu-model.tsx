import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { useAllWorktrees, useRepoById, useRepoMap, useWorktreeMap } from '@/store/selectors'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  getCyclicProjectedWorktreeLineageIds,
  getLineageRenderInfo
} from '../../../../shared/sidebar-list/worktree-lineage-projection'
import { useContextWorkspaceStatuses } from './use-workspace-board-statuses'
import { getEligibleWorktreeParents } from './worktree-parent-candidates'
import {
  hasSleepableWorkspaceActivity,
  useWorkspaceLineageMenuActions
} from './workspace-lineage-menu-actions'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getDeleteStateForWorktreeHost } from './worktree-delete-state-host-match'
import {
  EMPTY_AGENT_STATUS_BY_PANE_KEY,
  EMPTY_BROWSER_TABS_BY_WORKTREE,
  EMPTY_CYCLIC_LINEAGE_IDS,
  EMPTY_DELETE_STATE_BY_WORKTREE_ID,
  EMPTY_STRUCTURED_CHAT_SLEPT_AT,
  EMPTY_PTY_IDS_BY_TAB_ID,
  EMPTY_TABS_BY_WORKTREE,
  EMPTY_UNIFIED_TABS_BY_WORKTREE,
  EMPTY_WORKSPACE_LINEAGE_BY_CHILD_KEY,
  EMPTY_WORKTREE_LINEAGE_BY_ID,
  getSharedWorkspaceStatus,
  hasWorktreeParentLink,
  isContextWorktreeDeletable,
  selectMenuScopedMap,
  shouldRemoveProjectFromContextMenu
} from './worktree-context-menu-policy'
import { useWorktreeContextMenuCommands } from './use-worktree-context-menu-commands'
import { useWorktreeParentPickerTransition } from './use-worktree-parent-picker-transition'
import { useWorktreeContextMenuSecondaryActions } from './use-worktree-context-menu-secondary-actions'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '@/lib/close-all-context-menus'

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
  const setWorkspaceUnreadByUser = useAppStore((s) => s.setWorkspaceUnreadByUser)
  const setWorktreesPinnedAndReveal = useAppStore((s) => s.setWorktreesPinnedAndReveal)
  const openModal = useAppStore((s) => s.openModal)
  const projectGroups = useAppStore((s) => s.projectGroups)
  const createProjectGroup = useAppStore((s) => s.createProjectGroup)
  const moveProjectToGroup = useAppStore((s) => s.moveProjectToGroup)
  const repo = useRepoById(worktree.repoId)
  const deleteState = useAppStore((s) =>
    getDeleteStateForWorktreeHost(worktree, s.deleteStateByWorktreeId)
  )
  const [menuOpen, setMenuOpen] = useState(false)
  // Capture Option/Alt at menu open so Developer visibility cannot move items under the pointer.
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
  // Closed menus select stable empty maps; opening reads live maps without subscribing idle wrappers to teardown churn.
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
  const unifiedTabsByWorktree = useAppStore((s) =>
    selectMenuScopedMap(menuOpen, s.unifiedTabsByWorktree, EMPTY_UNIFIED_TABS_BY_WORKTREE)
  )
  const agentStatusByPaneKey = useAppStore((s) =>
    selectMenuScopedMap(menuOpen, s.agentStatusByPaneKey, EMPTY_AGENT_STATUS_BY_PANE_KEY)
  )
  const structuredChatSleptAtByPaneKey = useAppStore((s) =>
    selectMenuScopedMap(menuOpen, s.structuredChatSleptAtByPaneKey, EMPTY_STRUCTURED_CHAT_SLEPT_AT)
  )
  const deleteStateByWorktreeId = useAppStore((s) =>
    selectMenuScopedMap(menuOpen, s.deleteStateByWorktreeId, EMPTY_DELETE_STATE_BY_WORKTREE_ID)
  )
  const scopeRef = useRef<HTMLDivElement>(null)
  const contextMenuOpenedAtRef = useRef<number | null>(null)
  const activeContextWorktrees = menuOpen ? contextWorktrees : effectiveSelectedWorktrees
  const { workspaceStatuses, statusesForWorktree } =
    useContextWorkspaceStatuses(activeContextWorktrees)
  const isMultiContext = activeContextWorktrees.length > 1
  const workspaceScope = parseWorkspaceKey(worktree.id)
  const folderWorkspaceId =
    workspaceScope?.type === 'folder' ? workspaceScope.folderWorkspaceId : null
  const sleepActivity = useMemo(
    () => ({
      tabsByWorktree,
      ptyIdsByTabId,
      browserTabsByWorktree,
      unifiedTabsByWorktree,
      agentStatusByPaneKey,
      structuredChatSleptAtByPaneKey
    }),
    [
      agentStatusByPaneKey,
      browserTabsByWorktree,
      structuredChatSleptAtByPaneKey,
      ptyIdsByTabId,
      tabsByWorktree,
      unifiedTabsByWorktree
    ]
  )
  const sleepableWorktrees = useMemo(
    () =>
      activeContextWorktrees.filter((item) =>
        hasSleepableWorkspaceActivity(item.id, sleepActivity)
      ),
    [activeContextWorktrees, sleepActivity]
  )
  const lineageMenuActions = useWorkspaceLineageMenuActions({
    enabled: !isMultiContext,
    parent: worktree,
    worktrees: allWorktrees,
    lineageById: worktreeLineageById,
    activity: sleepActivity
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
  const contextWorkspaceStatus = useMemo(
    () => getSharedWorkspaceStatus(activeContextWorktrees, statusesForWorktree),
    [activeContextWorktrees, statusesForWorktree]
  )
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
  // Path-derived IDs can be reused; require the same instance check as grouped-row parent navigation.
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

  const commands = useWorktreeContextMenuCommands({
    getState: useAppStore.getState,
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
    setWorkspaceUnreadByUser,
    setWorktreesPinnedAndReveal,
    sleepableWorktrees,
    subtreeSleepableWorktrees,
    statusesForWorktree,
    updateWorktreeMeta,
    validParentWorktreeId,
    worktree
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
      // Suppress Radix focus restoration to a hidden trigger that can scroll the virtual list after Sleep/Delete.
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
    ...commands,
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
    handleCloseAutoFocus,
    handleOpenParentPicker,
    handleParentPickerOpenChange,
    handleRemoveParentLink,
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
