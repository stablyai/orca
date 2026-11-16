import { useIsPairedCloudPrimaryRow } from '@/lib/orca-cloud/cloud-host-rows'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store/index'
import { useRepoById } from '@/store/repos/use-repository-catalog'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { useContextWorkspaceStatuses } from '../../workspace-status/presentation/use-workspace-board-statuses'
import { useMenuScopedWorktreeCatalog } from './use-menu-scoped-worktree-catalog'
import { useMenuLineageParent } from './use-menu-lineage-parent'
import { useWorkspaceMenuActivity } from './workspace-lineage-menu-actions'
import { getWorkspaceDeleteLineage } from '../deletion/workspace-delete-lineage'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { getDeleteStateForWorktreeHost } from '../deletion/worktree-delete-state-host-match'
import {
  EMPTY_WORKTREES,
  EMPTY_WORKSPACE_LINEAGE_BY_CHILD_KEY,
  EMPTY_WORKTREE_LINEAGE_BY_ID,
  getSharedWorkspaceStatus,
  isContextWorktreeDeletable,
  selectMenuScopedMap,
  shouldRemoveProjectFromContextMenu
} from './worktree-context-menu-policy'
import { useWorktreeContextMenuCommands } from './use-worktree-context-menu-commands'
import {
  useWorktreeParentPickerTransition,
  type PendingParentPicker
} from '../parenting/use-worktree-parent-picker-transition'
import { useWorktreeContextMenuSecondaryActions } from './use-worktree-context-menu-secondary-actions'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '@/lib/overlay-interaction/close-all-context-menus'
import { getWorktreeContextMenuBatchLabels } from './workspace-batch-action-labels'
import { useTranslate } from '@/i18n/use-translate'

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
  const t = useTranslate()
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
  const [parentPicker, setParentPicker] = useState<PendingParentPicker | null>(null)
  const [parentPickerOpen, setParentPickerOpen] = useState(false)
  const pendingParentPickerRef = useRef<PendingParentPicker | null>(null)
  const parentPickerFallbackTimerRef = useRef<number | null>(null)
  const parentPickerUnmountTimerRef = useRef<number | null>(null)
  const lifecycleStartedRef = useRef(false)
  const isDeleting = deleteState?.isDeleting ?? false
  const { repoMap, worktreeMap, allWorktrees } = useMenuScopedWorktreeCatalog(menuOpen)
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
  const scopeRef = useRef<HTMLDivElement>(null)
  const contextMenuOpenedAtRef = useRef<number | null>(null)
  const activeContextWorktrees = menuOpen ? contextWorktrees : effectiveSelectedWorktrees
  const { workspaceStatuses, statusesForWorktree } =
    useContextWorkspaceStatuses(activeContextWorktrees)
  const isMultiContext = activeContextWorktrees.length > 1
  const workspaceScope = parseWorkspaceKey(worktree.id)
  const folderWorkspaceId =
    workspaceScope?.type === 'folder' ? workspaceScope.folderWorkspaceId : null
  // A paired cloud workspace can be running with nothing open here: its Sleep reaches the sandbox.
  const pairedCloudSleepable = useIsPairedCloudPrimaryRow(worktree) && !isMultiContext
  // Lineage reads only the catalog; per-workspace activity comes from narrow id selectors below.
  const lineageTargets = useMemo(
    () =>
      menuOpen && !isMultiContext
        ? [
            worktree,
            ...getWorkspaceDeleteLineage(worktree, allWorktrees, worktreeLineageById).descendants
          ]
        : EMPTY_WORKTREES,
    [allWorktrees, isMultiContext, menuOpen, worktree, worktreeLineageById]
  )
  const activityCandidates = useMemo(
    () => [
      ...activeContextWorktrees,
      ...lineageTargets.filter((target) => !activeContextWorktrees.includes(target))
    ],
    [activeContextWorktrees, lineageTargets]
  )
  const { sleepableIds, deletingIds } = useWorkspaceMenuActivity(menuOpen, activityCandidates)
  const sleepableWorktrees = useMemo(
    () =>
      activeContextWorktrees.filter(
        (item) =>
          sleepableIds.includes(item.id) || (pairedCloudSleepable && item.id === worktree.id)
      ),
    [activeContextWorktrees, sleepableIds, pairedCloudSleepable, worktree.id]
  )
  const lineageDescendantCount = Math.max(0, lineageTargets.length - 1)
  const subtreeSleepableWorktrees = useMemo(
    () => lineageTargets.filter((target) => sleepableIds.includes(target.id)),
    [lineageTargets, sleepableIds]
  )
  const deletingContext = activeContextWorktrees.some((item) => deletingIds.includes(item.id))
  const deletingSubtree = lineageTargets.some((item) => deletingIds.includes(item.id))
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
  const { sleepLabel, deleteLabel } = getWorktreeContextMenuBatchLabels(
    {
      isMultiContext,
      sleepableCount: sleepableWorktrees.length,
      deletableCount: batchDeleteWorktrees.length
    },
    t
  )
  const {
    hasParentLink,
    hasAnyContextLineage,
    cyclicLineageIds,
    validParent,
    eligibleParentCount
  } = useMenuLineageParent({
    menuOpen,
    worktree,
    activeContextWorktrees,
    allWorktrees,
    worktreeMap,
    repoMap,
    worktreeLineageById,
    workspaceLineageByChildKey
  })
  const validParentWorktreeId = validParent?.id ?? null

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
    validParent,
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
      worktree
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
    batchDeleteWorktrees,
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
    validParentWorktreeId,
    worktree,
    workspaceStatuses
  }
}

export type WorktreeContextMenuModel = ReturnType<typeof useWorktreeContextMenuModel>
