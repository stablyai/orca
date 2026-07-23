/* eslint-disable max-lines -- Why: this menu keeps row targeting, batch actions, and ctrl-click event guards together so nested worktree menus share one event policy. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Copy,
  Bell,
  BellOff,
  CircleX,
  Moon,
  Pencil,
  Pin,
  PinOff,
  Kanban,
  Trash2,
  Unlink,
  Workflow,
  FolderInput,
  FolderPlus,
  FolderTree
} from 'lucide-react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { useAllWorktrees, useRepoById, useRepoMap, useWorktreeMap } from '@/store/selectors'
import { cn } from '@/lib/utils'
import type { Repo, Worktree } from '../../../../shared/types'
import { runWorktreeBatchDelete, runWorktreeDelete } from './delete-worktree-flow'
import { runSleepWorktrees } from './sleep-worktree-flow'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import { VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT } from '@/hooks/useVirtualizedScrollAnchor'
import {
  getCyclicProjectedWorktreeLineageIds,
  getLineageRenderInfo,
  getProjectedWorktreeLineage
} from './worktree-lineage-projection'
import { getWorkspaceStatus, getWorkspaceStatusVisualMeta } from './workspace-status'
import { WorktreeOpenInSubMenu } from './WorktreeOpenInMenu'
import { ProjectGroupNameDialog } from './ProjectGroupNameDialog'
import { WorktreeParentPickerPopover } from './WorktreeParentPickerPopover'
import { getEligibleWorktreeParents } from './worktree-parent-candidates'
import { isEventTargetInsideCurrentTarget } from './worktree-card-dom-events'
import { translate } from '@/i18n/i18n'
import {
  folderWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../shared/workspace-scope'

type Props = {
  worktree: Worktree
  children: React.ReactNode
  contentClassName?: string
  selectedWorktrees?: readonly Worktree[]
  onContextMenuSelect?: (event: React.MouseEvent<HTMLElement>) => readonly Worktree[]
  onOpenChange?: (open: boolean) => void
}

const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'orca-close-all-context-menus'
const WORKTREE_CONTEXT_MENU_SCOPE_ATTR = 'data-worktree-context-menu-scope'
const WORKTREE_NATIVE_CONTEXT_MENU_ATTR = 'data-worktree-native-context-menu'
const CONTEXT_MENU_CLICK_SUPPRESSION_MS = 500
const DELETE_POSITION_RESTORE_MAX_FRAMES = 180
const DELETE_POSITION_RESTORE_STABLE_FRAMES = 6

// Why: stable empty sentinels let closed menu wrappers subscribe to a referentially
// stable value instead of the high-churn maps that delete teardown replaces. The
// selector returns these when the menu is closed, so the wrapper stays inert to
// teardown set() churn. Module-level (one allocation, never recreated per render) so
// the reference is constant and Zustand's Object.is equality short-circuits.
const EMPTY_TABS_BY_WORKTREE: AppState['tabsByWorktree'] = {}
const EMPTY_PTY_IDS_BY_TAB_ID: AppState['ptyIdsByTabId'] = {}
const EMPTY_BROWSER_TABS_BY_WORKTREE: AppState['browserTabsByWorktree'] = {}
const EMPTY_DELETE_STATE_BY_WORKTREE_ID: AppState['deleteStateByWorktreeId'] = {}
const EMPTY_WORKTREE_LINEAGE_BY_ID: AppState['worktreeLineageById'] = {}
const EMPTY_WORKSPACE_LINEAGE_BY_CHILD_KEY: AppState['workspaceLineageByChildKey'] = {}
const EMPTY_CYCLIC_LINEAGE_IDS: ReadonlySet<string> = new Set()

// Why: the gating decision for the menu-only store subscriptions. When the menu is
// closed we MUST return the same `empty` reference every render so Zustand's Object.is
// equality short-circuits the subscription and the closed wrapper stays inert to delete
// teardown's high-churn set()s. When open we return the live map so menu items see real
// data. Extracted as a pure function so the stable-reference contract is unit-testable.
export function selectMenuScopedMap<T>(menuOpen: boolean, live: T, empty: T): T {
  return menuOpen ? live : empty
}

export function hasWorktreeParentLink(
  worktree: Worktree,
  lineageById: AppState['worktreeLineageById'],
  workspaceLineageByChildKey: AppState['workspaceLineageByChildKey']
): boolean {
  return Boolean(
    getProjectedWorktreeLineage(worktree, lineageById) ||
    workspaceLineageByChildKey[worktreeWorkspaceKey(worktree.id)]
  )
}

function shouldUseNativeContextMenu(target: EventTarget | null): boolean {
  const maybeElement = target as {
    closest?: (selector: string) => Element | null
    parentElement?: { closest?: (selector: string) => Element | null }
  } | null
  const nativeContextMenuSelector = `[${WORKTREE_NATIVE_CONTEXT_MENU_ATTR}]`
  return (
    (maybeElement?.closest?.(nativeContextMenuSelector) ??
      maybeElement?.parentElement?.closest?.(nativeContextMenuSelector)) != null
  )
}

function shouldIgnoreNestedWorktreeContextMenuScope(
  currentTarget: EventTarget,
  target: EventTarget | null
): boolean {
  const maybeScopedTarget = target as {
    closest?: (selector: string) => Element | null
    parentElement?: { closest?: (selector: string) => Element | null }
  } | null
  const scopeSelector = `[${WORKTREE_CONTEXT_MENU_SCOPE_ATTR}]`
  const closestScope =
    maybeScopedTarget?.closest?.(scopeSelector) ??
    maybeScopedTarget?.parentElement?.closest?.(scopeSelector)
  // Why: lineage child previews live inside the parent card DOM but own their
  // context menu target. The parent must ignore only those nested scopes.
  return closestScope != null && closestScope !== currentTarget
}

function shouldSuppressContextMenuFollowUpClick(contextMenuOpenedAt: number, now: number): boolean {
  return (
    now - contextMenuOpenedAt >= 0 && now - contextMenuOpenedAt <= CONTEXT_MENU_CLICK_SUPPRESSION_MS
  )
}

function getWorktreeParentPickerLabel(validParentWorktreeId: string | null): string {
  return validParentWorktreeId
    ? translate(
        'auto.components.sidebar.WorktreeContextMenu.changeParentWorkspace',
        'Change Parent Worktree...'
      )
    : translate(
        'auto.components.sidebar.WorktreeContextMenu.setParentWorkspace',
        'Set Parent Worktree...'
      )
}

function isWorktreeParentPickerDisabled(args: {
  isDeleting: boolean
  eligibleParentCount: number
}): boolean {
  return args.isDeleting || args.eligibleParentCount === 0
}

function getWorktreeParentPickerAnchor(
  scope: HTMLElement | null,
  worktreeId: string
): HTMLElement | null {
  const dragRow = scope?.closest<HTMLElement>('[data-worktree-drag-id]')
  if (dragRow?.dataset.worktreeDragId === worktreeId) {
    return dragRow
  }
  return scope
}

function hasSleepableWorkspaceActivity(
  worktreeId: string,
  tabsByWorktree: Record<string, { id: string }[]>,
  ptyIdsByTabId: Record<string, string[]>,
  browserTabsByWorktree: Record<string, { id: string }[]>
): boolean {
  const tabs = tabsByWorktree[worktreeId] ?? []
  const hasLiveTerminal = tabs.some((tab) => tabHasLivePty(ptyIdsByTabId, tab.id))
  const hasBrowser = (browserTabsByWorktree[worktreeId] ?? []).length > 0
  return hasLiveTerminal || hasBrowser
}

function shouldRemoveProjectFromContextMenu(
  repo: Pick<Repo, 'id'> | null | undefined,
  worktree: Pick<Worktree, 'isMainWorktree'>
): boolean {
  return repo != null && worktree.isMainWorktree
}

function isContextWorktreeDeletable(
  worktree: Pick<Worktree, 'isMainWorktree'>,
  repo: Pick<Repo, 'kind'> | null | undefined
): boolean {
  return repo != null && !worktree.isMainWorktree
}

function findSidebarVirtualRowByKey(sidebar: Element, rowKey: string): HTMLElement | null {
  return (
    Array.from(sidebar.querySelectorAll<HTMLElement>('[data-worktree-virtual-row]')).find(
      (element) => element.getAttribute('data-worktree-virtual-row-key') === rowKey
    ) ?? null
  )
}

export function shouldContinueDeleteSiblingPositionRestore(args: {
  attempts: number
  stableFrames: number
}): boolean {
  // Why: slow deletes leave the target row mounted; after initial focus/remount
  // settling, the restore loop must stop so user scrolling wins.
  return (
    args.attempts < DELETE_POSITION_RESTORE_MAX_FRAMES &&
    args.stableFrames < DELETE_POSITION_RESTORE_STABLE_FRAMES
  )
}

function preserveDeleteSiblingPosition(scope: HTMLElement | null): () => void {
  const sidebar = scope?.closest('[data-worktree-sidebar]')
  const row = scope?.closest('[data-worktree-virtual-row]')
  if (!(sidebar instanceof HTMLElement) || !(row instanceof HTMLElement)) {
    return () => {}
  }
  const rows = Array.from(
    sidebar.querySelectorAll<HTMLElement>('[data-worktree-virtual-row]')
  ).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
  const rowIndex = rows.indexOf(row)
  const anchorRow = rows[rowIndex + 1] ?? rows[rowIndex - 1] ?? null
  const anchorKey = anchorRow?.getAttribute('data-worktree-virtual-row-key')
  const rowKey = row.getAttribute('data-worktree-virtual-row-key')
  if (!anchorKey || !rowKey) {
    return () => {}
  }
  const previousScrollTop = sidebar.scrollTop
  const previousScrollHeight = sidebar.scrollHeight
  const desiredTop = row.getBoundingClientRect().top

  return () => {
    let attempts = 0
    let stableFrames = 0
    const restore = (): void => {
      const currentSidebar = document.querySelector('[data-worktree-sidebar]')
      if (!(currentSidebar instanceof HTMLElement)) {
        return
      }
      const currentTarget = findSidebarVirtualRowByKey(currentSidebar, rowKey)
      const currentAnchor = currentTarget ?? findSidebarVirtualRowByKey(currentSidebar, anchorKey)
      if (currentAnchor) {
        const delta = currentAnchor.getBoundingClientRect().top - desiredTop
        if (Math.abs(delta) > 1) {
          currentSidebar.scrollTop += delta
          stableFrames = 0
        } else {
          stableFrames += 1
        }
      } else {
        currentSidebar.scrollTop = Math.max(
          0,
          previousScrollTop + currentSidebar.scrollHeight - previousScrollHeight
        )
        stableFrames = 0
      }
      attempts += 1
      if (
        shouldContinueDeleteSiblingPositionRestore({
          attempts,
          stableFrames
        })
      ) {
        window.requestAnimationFrame(restore)
      }
    }
    restore()
  }
}

const WorktreeContextMenu = React.memo(function WorktreeContextMenu({
  worktree,
  children,
  contentClassName,
  selectedWorktrees,
  onContextMenuSelect,
  onOpenChange
}: Props) {
  const defaultSelectedWorktrees = useMemo(() => [worktree], [worktree])
  const effectiveSelectedWorktrees = selectedWorktrees ?? defaultSelectedWorktrees
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const setWorktreesPinnedAndReveal = useAppStore((s) => s.setWorktreesPinnedAndReveal)
  const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)
  const openModal = useAppStore((s) => s.openModal)
  const projectGroups = useAppStore((s) => s.projectGroups)
  const createProjectGroup = useAppStore((s) => s.createProjectGroup)
  const moveProjectToGroup = useAppStore((s) => s.moveProjectToGroup)
  const deleteFolderWorkspace = useAppStore((s) => s.deleteFolderWorkspace)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const repo = useRepoById(worktree.repoId)
  const deleteState = useAppStore((s) => s.deleteStateByWorktreeId[worktree.id])
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })
  const [contextWorktrees, setContextWorktrees] = useState<readonly Worktree[]>(
    effectiveSelectedWorktrees
  )
  const [createGroupDialogOpen, setCreateGroupDialogOpen] = useState(false)
  const [parentPicker, setParentPicker] = useState<{
    childWorktreeId: string
    anchorElement: HTMLElement
  } | null>(null)
  const pendingParentPickerRef = useRef<{
    childWorktreeId: string
    anchorElement: HTMLElement
  } | null>(null)
  const parentPickerFallbackTimerRef = useRef<number | null>(null)
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
        hasSleepableWorkspaceActivity(item.id, tabsByWorktree, ptyIdsByTabId, browserTabsByWorktree)
      ),
    [activeContextWorktrees, browserTabsByWorktree, ptyIdsByTabId, tabsByWorktree]
  )
  const deletingContext = useMemo(
    () => activeContextWorktrees.some((item) => deleteStateByWorktreeId[item.id]?.isDeleting),
    [activeContextWorktrees, deleteStateByWorktreeId]
  )
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
      onOpenChange?.(open)
    },
    [onOpenChange]
  )

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
    },
    []
  )

  const handleCopyPath = useCallback(() => {
    window.api.ui.writeClipboardText(worktree.path)
  }, [worktree.path])

  const handleToggleRead = useCallback(() => {
    updateWorktreeMeta(worktree.id, { isUnread: !worktree.isUnread })
  }, [worktree.id, worktree.isUnread, updateWorktreeMeta])

  const handleTogglePin = useCallback(() => {
    setWorktreesPinnedAndReveal([worktree.id], !worktree.isPinned)
  }, [worktree.id, worktree.isPinned, setWorktreesPinnedAndReveal])

  const handleCreateGroupFromRepo = useCallback(() => {
    if (!repo) {
      return
    }
    setCreateGroupDialogOpen(true)
  }, [repo])

  const handleSubmitNewProjectGroup = useCallback(
    async (name: string) => {
      if (!repo) {
        return
      }
      const group = await createProjectGroup(name)
      if (group) {
        await moveProjectToGroup(repo.id, group.id)
      }
    },
    [createProjectGroup, moveProjectToGroup, repo]
  )

  const handleMoveProjectToGroup = useCallback(
    (groupId: string) => {
      if (!repo || repo.projectGroupId === groupId) {
        return
      }
      void moveProjectToGroup(repo.id, groupId)
    },
    [moveProjectToGroup, repo]
  )

  const handleRemoveProjectFromGroup = useCallback(() => {
    if (!repo) {
      return
    }
    void moveProjectToGroup(repo.id, null)
  }, [moveProjectToGroup, repo])

  const handleAssignWorkspaceStatus = useCallback(
    (status: string) => {
      setMenuOpenState(false)
      void Promise.all(
        activeContextWorktrees.map((item) =>
          getWorkspaceStatus(item, workspaceStatuses) === status
            ? Promise.resolve()
            : updateWorktreeMeta(item.id, { workspaceStatus: status })
        )
      )
    },
    [activeContextWorktrees, setMenuOpenState, updateWorktreeMeta, workspaceStatuses]
  )

  const handleRename = useCallback(() => {
    openModal('edit-meta', {
      worktreeId: worktree.id,
      currentDisplayName: worktree.displayName,
      currentIssue: worktree.linkedIssue,
      currentPR: worktree.linkedPR,
      currentComment: worktree.comment,
      focus: 'displayName'
    })
  }, [
    worktree.id,
    worktree.displayName,
    worktree.linkedIssue,
    worktree.linkedPR,
    worktree.comment,
    openModal
  ])

  const handleCloseTerminals = useCallback(() => {
    const worktreeIds = sleepableWorktrees.map((item) => item.id)
    setMenuOpenState(false)
    // Why: Sleep can remount the sidebar when it clears the active workspace.
    // Let Radix finish closing the menu first so its focus/portal teardown
    // cannot scroll the virtualized list during that remount.
    window.setTimeout(() => {
      void runSleepWorktrees(worktreeIds)
    }, 50)
  }, [setMenuOpenState, sleepableWorktrees])

  const handleDelete = useCallback(() => {
    // Folder mode handled inline because it routes to a different modal;
    // standard delete delegates to the shared runWorktreeDelete helper.
    const restoreSidebarPosition = preserveDeleteSiblingPosition(scopeRef.current)
    scopeRef.current
      ?.closest('[data-worktree-sidebar]')
      ?.dispatchEvent(new Event(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT))
    setMenuOpenState(false)
    // Why: Delete can remove the active row and remount the sidebar. Run it
    // after menu close for the same reason as Sleep above.
    window.setTimeout(() => {
      if (isMultiContext) {
        runWorktreeBatchDelete(batchDeleteWorktrees.map((item) => item.id))
        restoreSidebarPosition()
        return
      }
      if (folderWorkspaceId) {
        void deleteFolderWorkspace(folderWorkspaceId).then((deleted) => {
          if (
            deleted &&
            useAppStore.getState().activeWorktreeId === folderWorkspaceKey(folderWorkspaceId)
          ) {
            setActiveWorktree(null)
          }
        })
        restoreSidebarPosition()
        return
      }
      // Why delegate to runWorktreeDelete: keeps the delete-vs-project-removal
      // decision tree (and its rationale) in one place shared with command
      // surfaces and the memory popover's inline Delete action.
      runWorktreeDelete(worktree.id)
      restoreSidebarPosition()
    }, 50)
  }, [
    batchDeleteWorktrees,
    deleteFolderWorkspace,
    folderWorkspaceId,
    isMultiContext,
    setActiveWorktree,
    setMenuOpenState,
    worktree.id
  ])

  const handleOpenParent = useCallback(() => {
    if (validParentWorktreeId) {
      activateAndRevealWorktree(validParentWorktreeId)
    }
  }, [validParentWorktreeId])

  const openPendingParentPicker = useCallback(() => {
    const pendingParentPicker = pendingParentPickerRef.current
    if (!pendingParentPicker) {
      return
    }
    pendingParentPickerRef.current = null
    if (parentPickerFallbackTimerRef.current != null) {
      window.clearTimeout(parentPickerFallbackTimerRef.current)
      parentPickerFallbackTimerRef.current = null
    }
    setParentPicker(pendingParentPicker)
  }, [])

  const handleOpenParentPicker = useCallback(
    (event?: { preventDefault: () => void }) => {
      event?.preventDefault()
      const anchorElement = getWorktreeParentPickerAnchor(scopeRef.current, worktree.id)
      if (!anchorElement) {
        return
      }
      pendingParentPickerRef.current = { childWorktreeId: worktree.id, anchorElement }
      setMenuOpenState(false)
      // Why: the picker should open from Radix's close-auto-focus callback, but
      // this keeps keyboard activation working if that callback is skipped.
      parentPickerFallbackTimerRef.current = window.setTimeout(openPendingParentPicker, 50)
    },
    [openPendingParentPicker, setMenuOpenState, worktree.id]
  )

  const handleRemoveParentLink = useCallback(() => {
    void Promise.all(
      activeContextWorktrees.map((item) => updateWorktreeLineage(item.id, { noParent: true }))
    )
  }, [activeContextWorktrees, updateWorktreeLineage])

  const suppressOpeningPointerEvent = useCallback((event: React.SyntheticEvent) => {
    const contextMenuOpenedAt = contextMenuOpenedAtRef.current
    if (
      contextMenuOpenedAt == null ||
      !shouldSuppressContextMenuFollowUpClick(contextMenuOpenedAt, Date.now())
    ) {
      if (contextMenuOpenedAt != null) {
        contextMenuOpenedAtRef.current = null
      }
      return
    }
    // Why: macOS ctrl-click can release over the just-opened menu, selecting
    // the item under the cursor unless the opening pointer sequence is ignored.
    event.preventDefault()
    event.stopPropagation()
    if (event.type === 'click') {
      contextMenuOpenedAtRef.current = null
    }
  }, [])

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

  return (
    <div
      ref={scopeRef}
      className="relative"
      {...{ [WORKTREE_CONTEXT_MENU_SCOPE_ATTR]: 'worktree' }}
      onContextMenuCapture={(event) => {
        if (!isEventTargetInsideCurrentTarget(event.currentTarget, event.target)) {
          return
        }
        if (shouldUseNativeContextMenu(event.target)) {
          return
        }
        if (shouldIgnoreNestedWorktreeContextMenuScope(event.currentTarget, event.target)) {
          return
        }
        event.preventDefault()
        contextMenuOpenedAtRef.current = Date.now()
        window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
        setContextWorktrees(onContextMenuSelect?.(event) ?? effectiveSelectedWorktrees)
        const bounds = event.currentTarget.getBoundingClientRect()
        setMenuPoint({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
        setMenuOpenState(true)
      }}
      onClickCapture={(event) => {
        suppressOpeningPointerEvent(event)
      }}
    >
      {children}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpenState} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none absolute size-px opacity-0"
            style={{ left: menuPoint.x, top: menuPoint.y }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className={cn('w-52', contentClassName)}
          sideOffset={0}
          align="start"
          onPointerUpCapture={suppressOpeningPointerEvent}
          onPointerDownCapture={(event) => {
            if (event.button === 0) {
              contextMenuOpenedAtRef.current = null
            }
          }}
          onMouseUpCapture={suppressOpeningPointerEvent}
          onClickCapture={suppressOpeningPointerEvent}
          onCloseAutoFocus={handleCloseAutoFocus}
        >
          <DropdownMenuLabel className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
            {translate('auto.components.sidebar.WorktreeContextMenu.workspaceSection', 'Workspace')}
          </DropdownMenuLabel>
          {!isMultiContext && (
            <DropdownMenuItem onSelect={handleRename} disabled={isDeleting}>
              <Pencil className="size-3.5" />
              {translate('auto.components.sidebar.WorktreeContextMenu.439fa94d53', 'Update')}
            </DropdownMenuItem>
          )}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={deletingContext}>
              <Kanban className="size-3.5" />
              {isMultiContext
                ? translate(
                    'auto.components.sidebar.WorktreeContextMenu.56cde9e8e6',
                    'Move Statuses To'
                  )
                : translate(
                    'auto.components.sidebar.WorktreeContextMenu.84cdbb7e30',
                    'Move to Status'
                  )}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-44">
              <DropdownMenuRadioGroup value={contextWorkspaceStatus}>
                {workspaceStatuses.map((status) => {
                  const meta = getWorkspaceStatusVisualMeta(status)
                  return (
                    <DropdownMenuRadioItem
                      key={status.id}
                      value={status.id}
                      onSelect={() => handleAssignWorkspaceStatus(status.id)}
                    >
                      <meta.icon className={cn('size-3.5', meta.tone)} />
                      {status.label}
                    </DropdownMenuRadioItem>
                  )
                })}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          {!isMultiContext && (
            <>
              <WorktreeOpenInSubMenu
                worktreePath={worktree.path}
                connectionId={repo?.connectionId ?? null}
                disabled={isDeleting}
              />
              <DropdownMenuItem onSelect={handleCopyPath} disabled={isDeleting}>
                <Copy className="size-3.5" />
                {translate('auto.components.sidebar.WorktreeContextMenu.3350101edb', 'Copy Path')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={handleTogglePin} disabled={isDeleting}>
                {worktree.isPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                {worktree.isPinned
                  ? translate('auto.components.sidebar.WorktreeContextMenu.697d0f6e1b', 'Unpin')
                  : translate('auto.components.sidebar.WorktreeContextMenu.3baa7d6507', 'Pin')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={handleToggleRead} disabled={isDeleting}>
                {worktree.isUnread ? (
                  <BellOff className="size-3.5" />
                ) : (
                  <Bell className="size-3.5" />
                )}
                {worktree.isUnread
                  ? translate('auto.components.sidebar.WorktreeContextMenu.8dacff1fe0', 'Mark Read')
                  : translate(
                      'auto.components.sidebar.WorktreeContextMenu.f50603c6b2',
                      'Mark Unread'
                    )}
              </DropdownMenuItem>
              {repo ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={handleCreateGroupFromRepo} disabled={isDeleting}>
                    <FolderPlus className="size-3.5" />
                    {translate(
                      'auto.components.sidebar.WorktreeContextMenu.503ec0f8e6',
                      'New group from project'
                    )}
                  </DropdownMenuItem>
                  {projectGroups.length > 0 ? (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger disabled={isDeleting}>
                        <FolderInput className="size-3.5" />
                        {translate(
                          'auto.components.sidebar.WorktreeContextMenu.76865d827f',
                          'Move to group'
                        )}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        {projectGroups.map((group) => (
                          <DropdownMenuItem
                            key={group.id}
                            disabled={repo.projectGroupId === group.id}
                            onSelect={() => handleMoveProjectToGroup(group.id)}
                          >
                            <span className="max-w-48 truncate">{group.name}</span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ) : null}
                  {repo.projectGroupId ? (
                    <DropdownMenuItem onSelect={handleRemoveProjectFromGroup} disabled={isDeleting}>
                      <CircleX className="size-3.5" />
                      {translate(
                        'auto.components.sidebar.WorktreeContextMenu.d35dfeae58',
                        'Remove from group'
                      )}
                    </DropdownMenuItem>
                  ) : null}
                </>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={handleOpenParentPicker}
                disabled={isWorktreeParentPickerDisabled({ isDeleting, eligibleParentCount })}
              >
                <FolderTree className="size-3.5" />
                {getWorktreeParentPickerLabel(validParentWorktreeId)}
              </DropdownMenuItem>
              {(validParentWorktreeId || hasParentLink) && (
                <>
                  {validParentWorktreeId && (
                    <DropdownMenuItem onSelect={handleOpenParent} disabled={isDeleting}>
                      <Workflow className="size-3.5" />
                      {translate(
                        'auto.components.sidebar.WorktreeContextMenu.8d9cd19d09',
                        'Open Parent Worktree'
                      )}
                    </DropdownMenuItem>
                  )}
                  {hasParentLink && (
                    <DropdownMenuItem onSelect={handleRemoveParentLink} disabled={isDeleting}>
                      <Unlink className="size-3.5" />
                      {translate(
                        'auto.components.sidebar.WorktreeContextMenu.579b1a8e61',
                        'Remove from Parent'
                      )}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                </>
              )}
            </>
          )}
          {isMultiContext && hasAnyContextLineage ? (
            <>
              <DropdownMenuItem onSelect={handleRemoveParentLink} disabled={deletingContext}>
                <Unlink className="size-3.5" />
                {translate(
                  'auto.components.sidebar.WorktreeContextMenu.579b1a8e61',
                  'Remove from Parent'
                )}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}

          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuItem
                onSelect={handleCloseTerminals}
                disabled={deletingContext || sleepableWorktrees.length === 0}
              >
                <Moon className="size-3.5" />
                {sleepLabel}
              </DropdownMenuItem>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8} className="max-w-[200px] text-pretty">
              {isMultiContext
                ? translate(
                    'auto.components.sidebar.WorktreeContextMenu.7d190f7d2b',
                    'Close all active panels in the selected workspaces to free up memory and CPU.'
                  )
                : translate(
                    'auto.components.sidebar.WorktreeContextMenu.0918b35e4f',
                    'Close all active panels in this workspace to free up memory and CPU.'
                  )}
            </TooltipContent>
          </Tooltip>
          {/* Why: primary checkout rows can't be git-worktree-removed, so keep a
             disabled Delete Worktree for parity with non-primary cards and pair
             it with the enabled Remove Project action below. */}
          {!isMultiContext && removesProject ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <DropdownMenuItem variant="destructive" disabled>
                    <Trash2 className="size-3.5" />
                    {translate(
                      'auto.components.sidebar.WorktreeContextMenu.deleteWorktree',
                      'Delete Worktree'
                    )}
                  </DropdownMenuItem>
                </div>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8} className="max-w-[200px] text-pretty">
                {translate(
                  'auto.components.sidebar.WorktreeContextMenu.primaryDeleteDisabled',
                  "Primary worktree — can't be deleted. Remove the project instead."
                )}
              </TooltipContent>
            </Tooltip>
          ) : null}
          {/* Why: primary checkout rows remove the project from Orca instead of
             invoking git worktree deletion. Radix forwards unknown props to the
             DOM element, so `title` works directly without a wrapper span —
             this preserves Radix's flat roving-tabindex keyboard navigation. */}
          <DropdownMenuItem
            variant="destructive"
            onSelect={handleDelete}
            disabled={
              deletingContext ||
              (!isMultiContext && worktree.isMainWorktree && !removesProject) ||
              (isMultiContext && batchDeleteWorktrees.length === 0)
            }
            title={
              !isMultiContext && worktree.isMainWorktree && !removesProject
                ? translate(
                    'auto.components.sidebar.WorktreeContextMenu.e091caab15',
                    'The project could not be found'
                  )
                : undefined
            }
          >
            <Trash2 className="size-3.5" />
            {deletingContext
              ? translate('auto.components.sidebar.WorktreeContextMenu.b42391d8bf', 'Deleting…')
              : isMultiContext
                ? deleteLabel
                : folderWorkspaceId
                  ? translate(
                      'auto.components.sidebar.WorktreeContextMenu.250de158fd',
                      'Remove Workspace'
                    )
                  : removesProject
                    ? translate(
                        'auto.components.sidebar.WorktreeContextMenu.f5ac91531d',
                        'Remove Project from Orca'
                      )
                    : translate('auto.components.sidebar.WorktreeContextMenu.f4475537d8', 'Delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ProjectGroupNameDialog
        open={createGroupDialogOpen}
        title={translate(
          'auto.components.sidebar.WorktreeContextMenu.6664418e98',
          'New Project Group'
        )}
        description={translate(
          'auto.components.sidebar.WorktreeContextMenu.c39c37676a',
          'Create a group and move this project into it.'
        )}
        initialName={repo ? `${repo.displayName} group` : ''}
        confirmLabel="Create"
        onOpenChange={setCreateGroupDialogOpen}
        onSubmit={handleSubmitNewProjectGroup}
      />
      <WorktreeParentPickerPopover
        open={parentPicker !== null}
        childWorktreeId={parentPicker?.childWorktreeId ?? null}
        anchorElement={parentPicker?.anchorElement ?? null}
        onOpenChange={(open) => {
          if (!open) {
            setParentPicker(null)
          }
        }}
      />
    </div>
  )
})

export default WorktreeContextMenu
export {
  CLOSE_ALL_CONTEXT_MENUS_EVENT,
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR,
  WORKTREE_NATIVE_CONTEXT_MENU_ATTR,
  hasSleepableWorkspaceActivity,
  isContextWorktreeDeletable,
  getWorktreeParentPickerAnchor,
  getWorktreeParentPickerLabel,
  isWorktreeParentPickerDisabled,
  shouldRemoveProjectFromContextMenu,
  shouldUseNativeContextMenu,
  shouldSuppressContextMenuFollowUpClick,
  shouldIgnoreNestedWorktreeContextMenuScope
}
