import { createContext } from 'react'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import {
  requestVirtualizedScrollAnchorRecord,
  supersedeVirtualizedScrollAnchorRestore
} from '@/lib/list-interaction/virtualized-scrolling/requestVirtualizedScrollAnchorRecord'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { isGitRepoKind } from '../../../../../../shared/repository/repo-kind'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import '@/lib/workspace/creation/new-workspace-composer-repo'
import { getNewWorkspaceDialogEligibleRepos } from '../../../../../../shared/new-workspace/new-workspace-dialog-repo'
import type {
  WorkspaceStatus,
  WorkspaceStatusDefinition,
  Worktree
} from '../../../../../../shared/worktree/types'
import { getProjectedWorktreeLineage } from '../../../../../../shared/worktree/lineage/workspace-lineage-graph'
import '../../workspace-status/presentation/workspace-status'
import { getWorkspaceStatus } from '../../../../../../shared/workspace/status/workspace-statuses'
import { translate } from '@/i18n/i18n'
import {
  workspaceKeyOfRow,
  worktreeWorkspaceKey
} from '../../../../../../shared/workspace/identity/workspace-scope'
import type { Translate } from '@/i18n/use-translate'
import { lineageStoreKeyOfRow } from '../../../../../../shared/worktree/lineage/cross-store-lineage-resolution'

export const WORKTREE_CONTEXT_MENU_SCOPE_ATTR = 'data-worktree-context-menu-scope'
export const WORKTREE_NATIVE_CONTEXT_MENU_ATTR = 'data-worktree-native-context-menu'
export const WORKTREE_CONTEXT_MENU_PORTAL_SCOPE_ATTR = 'data-worktree-context-menu-portal-scope'
export const WorktreeContextMenuPortalScope = createContext<string | null>(null)
const CONTEXT_MENU_CLICK_SUPPRESSION_MS = 500
const DELETE_POSITION_RESTORE_MAX_FRAMES = 180
const DELETE_POSITION_RESTORE_STABLE_FRAMES = 6
// Keep the closing picker mounted through its PopoverContent exit animation.
export const PARENT_PICKER_EXIT_ANIMATION_MS = 200

// Closed menus reuse empty identities so teardown map churn cannot wake their subscriptions.
export const EMPTY_TABS_BY_WORKTREE: AppState['tabsByWorktree'] = {}
export const EMPTY_PTY_IDS_BY_TAB_ID: AppState['ptyIdsByTabId'] = {}
export const EMPTY_BROWSER_TABS_BY_WORKTREE: AppState['browserTabsByWorktree'] = {}
export const EMPTY_UNIFIED_TABS_BY_WORKTREE: AppState['unifiedTabsByWorktree'] = {}
export const EMPTY_AGENT_STATUS_BY_PANE_KEY: AppState['agentStatusByPaneKey'] =
  acceptedAgentStatuses()
export const EMPTY_STRUCTURED_CHAT_SLEPT_AT: AppState['structuredChatSleptAtByPaneKey'] = {}
export const EMPTY_DELETE_STATE_BY_WORKTREE_ID: AppState['deleteStateByWorktreeId'] = {}
export const EMPTY_WORKTREE_LINEAGE_BY_ID: AppState['worktreeLineageById'] = {}
export const EMPTY_WORKSPACE_LINEAGE_BY_CHILD_KEY: AppState['workspaceLineageByChildKey'] = {}
export const EMPTY_CROSS_STORE_LINEAGE_BY_STORE_KEY: AppState['crossStoreLineageByStoreKey'] = {}
export const EMPTY_CYCLIC_LINEAGE_IDS: ReadonlySet<string> = new Set()
export const EMPTY_WORKTREES: readonly Worktree[] = []
export const EMPTY_WORKTREE_MAP: ReadonlyMap<string, Worktree> = new Map()
export const EMPTY_REPO_MAP: ReadonlyMap<string, Repo> = new Map()

// Return the shared empty reference while closed; open menus read current maps.
export function selectMenuScopedMap<T>(menuOpen: boolean, live: T, empty: T): T {
  return menuOpen ? live : empty
}

/** Twin hosts share one worktree id bucket, so a row's copy menu offers only that row's host, keeping unstamped legacy tabs. */
export function agentSessionTabsOfRow(
  tabs: readonly Tab[],
  rowHostId: ExecutionHostId
): readonly Tab[] {
  return tabs.filter(
    (tab) =>
      tab.contentType === 'agent-session' &&
      tab.entityId.trim() !== '' &&
      (!tab.executionHostId || tab.executionHostId === rowHostId)
  )
}

// Reveal Developer on Option/Alt at right-click; altKey works across macOS, Windows and Linux.
export function shouldRevealWorktreeDeveloperMenu(args: {
  developerMenuRevealed: boolean
  isMultiContext: boolean
}): boolean {
  return args.developerMenuRevealed && !args.isMultiContext
}

export function hasWorktreeParentLink(
  worktree: Worktree,
  lineageById: AppState['worktreeLineageById'],
  workspaceLineageByChildKey: AppState['workspaceLineageByChildKey'],
  crossStoreLineageByStoreKey?: AppState['crossStoreLineageByStoreKey']
): boolean {
  const storeKey = lineageStoreKeyOfRow(worktree)
  return Boolean(
    getProjectedWorktreeLineage(worktree, lineageById) ||
    workspaceLineageByChildKey[workspaceKeyOfRow(worktree.id)] ||
    // A saved parent on another machine is removable even while it can't be found.
    (storeKey !== undefined &&
      crossStoreLineageByStoreKey?.[storeKey]?.[worktreeWorkspaceKey(worktree.id)])
  )
}

function closestContextMenuElement(target: EventTarget | null, selector: string): Element | null {
  const maybeElement = target as {
    closest?: (selector: string) => Element | null
    parentElement?: { closest?: (selector: string) => Element | null }
  } | null
  return (
    maybeElement?.closest?.(selector) ?? maybeElement?.parentElement?.closest?.(selector) ?? null
  )
}

export function shouldUseNativeContextMenu(target: EventTarget | null): boolean {
  return closestContextMenuElement(target, `[${WORKTREE_NATIVE_CONTEXT_MENU_ATTR}]`) !== null
}

export function isFromWorkspaceAgentRow(scope: Element, target: EventTarget | null): boolean {
  const row = closestContextMenuElement(target, '[data-workspace-agent-row]')
  return row?.closest(`[${WORKTREE_CONTEXT_MENU_SCOPE_ATTR}]`) === scope
}

/** A right-click on an agent row that this menu's owner rendered into a portal, such as its details hover. */
export function isOwnedWorktreeContextMenuPortal(
  target: EventTarget | null,
  scopeId: string
): boolean {
  const scope = closestContextMenuElement(target, `[${WORKTREE_CONTEXT_MENU_PORTAL_SCOPE_ATTR}]`)
  if (scope?.getAttribute(WORKTREE_CONTEXT_MENU_PORTAL_SCOPE_ATTR) !== scopeId) {
    return false
  }
  const row = closestContextMenuElement(target, '.agent-disclosure-row')
  return row !== null && scope.contains(row)
}

export function shouldIgnoreNestedWorktreeContextMenuScope(
  currentTarget: EventTarget,
  target: EventTarget | null
): boolean {
  const closestScope = closestContextMenuElement(target, `[${WORKTREE_CONTEXT_MENU_SCOPE_ATTR}]`)
  // Nested lineage previews own context menus even though they sit inside the parent DOM.
  return closestScope != null && closestScope !== currentTarget
}

export function shouldSuppressContextMenuFollowUpClick(
  contextMenuOpenedAt: number,
  now: number
): boolean {
  return (
    now - contextMenuOpenedAt >= 0 && now - contextMenuOpenedAt <= CONTEXT_MENU_CLICK_SUPPRESSION_MS
  )
}

export function getWorktreeParentPickerLabel(
  validParentWorktreeId: string | null,
  t: Translate = translate
): string {
  return validParentWorktreeId
    ? t(
        'auto.components.sidebar.WorktreeContextMenu.changeParentWorkspace',
        'Change Parent Worktree...'
      )
    : t('auto.components.sidebar.WorktreeContextMenu.setParentWorkspace', 'Set Parent Worktree...')
}

export function isWorktreeParentPickerDisabled(args: {
  isDeleting: boolean
  eligibleParentCount: number
}): boolean {
  return args.isDeleting || args.eligibleParentCount === 0
}

export function canCreateChildWorktree(args: {
  repo: Repo | null | undefined
  folderWorkspaceId: string | null
  worktree: Pick<Worktree, 'isArchived'>
}): boolean {
  return (
    args.repo != null &&
    isGitRepoKind(args.repo) &&
    getNewWorkspaceDialogEligibleRepos([args.repo]).length > 0 &&
    !args.folderWorkspaceId &&
    !args.worktree.isArchived
  )
}

export function getWorktreeParentPickerAnchor(
  scope: HTMLElement | null,
  worktreeId: string
): HTMLElement | null {
  const dragRow = scope?.closest<HTMLElement>('[data-worktree-drag-id]')
  if (dragRow?.dataset.worktreeDragId === worktreeId) {
    return dragRow
  }
  return scope
}

export function shouldRemoveProjectFromContextMenu(
  repo: Pick<Repo, 'id'> | null | undefined,
  worktree: Pick<Worktree, 'isMainWorktree'>
): boolean {
  return repo != null && worktree.isMainWorktree
}

export function isContextWorktreeDeletable(
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
  // Stop restoring once position settles so user scrolling wins during slow deletes.
  return (
    args.attempts < DELETE_POSITION_RESTORE_MAX_FRAMES &&
    args.stableFrames < DELETE_POSITION_RESTORE_STABLE_FRAMES
  )
}

export function preserveDeleteSiblingPosition(scope: HTMLElement | null): () => void {
  const sidebar = scope?.closest('[data-worktree-sidebar]')
  const row = scope?.closest('[data-worktree-virtual-row]')
  if (!(sidebar instanceof HTMLElement) || !(row instanceof HTMLElement)) {
    return () => {}
  }
  const rows = Array.from(sidebar.querySelectorAll<HTMLElement>('[data-worktree-virtual-row]'))
    .map((element) => ({ element, top: element.getBoundingClientRect().top }))
    .sort((a, b) => a.top - b.top)
    .map(({ element }) => element)
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
  supersedeVirtualizedScrollAnchorRestore(sidebar)

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
        supersedeVirtualizedScrollAnchorRestore(
          currentSidebar,
          Math.abs(delta) > 1 ? currentSidebar.scrollTop + delta : undefined
        )
        if (Math.abs(delta) > 1) {
          currentSidebar.scrollTop += delta
          stableFrames = 0
        } else {
          stableFrames += 1
        }
      } else {
        const target = Math.max(
          0,
          previousScrollTop + currentSidebar.scrollHeight - previousScrollHeight
        )
        supersedeVirtualizedScrollAnchorRestore(currentSidebar, target)
        currentSidebar.scrollTop = target
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
      } else {
        requestVirtualizedScrollAnchorRecord(currentSidebar)
      }
    }
    restore()
  }
}

/** The status every context worktree shares, or '' when they differ or there are none. */
export function getSharedWorkspaceStatus(
  worktrees: readonly Worktree[],
  statusesFor: (worktree: Worktree) => readonly WorkspaceStatusDefinition[]
): WorkspaceStatus {
  const [first, ...rest] = worktrees
  if (!first) {
    return ''
  }
  const status = getWorkspaceStatus(first, statusesFor(first))
  return rest.every((item) => getWorkspaceStatus(item, statusesFor(item)) === status) ? status : ''
}

export type WorkspaceStatusAssignmentPlan =
  | { readonly kind: 'board-sync'; readonly worktreeIds: readonly string[] }
  | { readonly kind: 'local-only'; readonly localWriteIds: readonly string[] }

// Board callbacks own local-first/provider sync; otherwise write only changed statuses locally.
export function planWorkspaceStatusAssignment(
  worktrees: readonly Worktree[],
  status: WorkspaceStatus,
  statusesFor: (worktree: Worktree) => readonly WorkspaceStatusDefinition[],
  boardSyncEnabled: boolean
): WorkspaceStatusAssignmentPlan {
  if (boardSyncEnabled) {
    return { kind: 'board-sync', worktreeIds: worktrees.map((item) => item.id) }
  }
  const localWriteIds = worktrees
    .filter((item) => getWorkspaceStatus(item, statusesFor(item)) !== status)
    .map((item) => item.id)
  return { kind: 'local-only', localWriteIds }
}
