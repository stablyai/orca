import type { AppState } from '@/store/types'
import type { Repo } from '../../../../shared/repo-types'
import type {
  WorkspaceStatus,
  WorkspaceStatusDefinition,
  Worktree
} from '../../../../shared/worktree/types'
import { getProjectedWorktreeLineage } from './worktree-lineage-projection'
import { getWorkspaceStatus } from './workspace-status'
import { translate } from '@/i18n/i18n'
import { worktreeWorkspaceKey } from '../../../../shared/workspace-scope'

export const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'orca-close-all-context-menus'
export const WORKTREE_CONTEXT_MENU_SCOPE_ATTR = 'data-worktree-context-menu-scope'
export const WORKTREE_NATIVE_CONTEXT_MENU_ATTR = 'data-worktree-native-context-menu'
const CONTEXT_MENU_CLICK_SUPPRESSION_MS = 500
const DELETE_POSITION_RESTORE_MAX_FRAMES = 180
const DELETE_POSITION_RESTORE_STABLE_FRAMES = 6
// Why: the picker is unmounted on close, which would cut PopoverContent's
// data-[state=closed] exit animation short; hold the subtree for its duration.
export const PARENT_PICKER_EXIT_ANIMATION_MS = 200

// Why: stable empty sentinels let closed menu wrappers subscribe to a referentially
// stable value instead of the high-churn maps that delete teardown replaces. The
// selector returns these when the menu is closed, so the wrapper stays inert to
// teardown set() churn. Module-level (one allocation, never recreated per render) so
// the reference is constant and Zustand's Object.is equality short-circuits.
export const EMPTY_TABS_BY_WORKTREE: AppState['tabsByWorktree'] = {}
export const EMPTY_PTY_IDS_BY_TAB_ID: AppState['ptyIdsByTabId'] = {}
export const EMPTY_BROWSER_TABS_BY_WORKTREE: AppState['browserTabsByWorktree'] = {}
export const EMPTY_DELETE_STATE_BY_WORKTREE_ID: AppState['deleteStateByWorktreeId'] = {}
export const EMPTY_WORKTREE_LINEAGE_BY_ID: AppState['worktreeLineageById'] = {}
export const EMPTY_WORKSPACE_LINEAGE_BY_CHILD_KEY: AppState['workspaceLineageByChildKey'] = {}
export const EMPTY_CYCLIC_LINEAGE_IDS: ReadonlySet<string> = new Set()

// Why: the gating decision for the menu-only store subscriptions. When the menu is
// closed we MUST return the same `empty` reference every render so Zustand's Object.is
// equality short-circuits the subscription and the closed wrapper stays inert to delete
// teardown's high-churn set()s. When open we return the live map so menu items see real
// data. Extracted as a pure function so the stable-reference contract is unit-testable.
export function selectMenuScopedMap<T>(menuOpen: boolean, live: T, empty: T): T {
  return menuOpen ? live : empty
}

// Why: the Developer submenu is hidden by default and revealed only by holding
// Option/Alt at right-click. altKey is the same physical key on every platform
// (Option on macOS, Alt on Windows/Linux), so no platform branch is needed.
export function shouldRevealWorktreeDeveloperMenu(args: {
  developerMenuRevealed: boolean
  isMultiContext: boolean
}): boolean {
  return args.developerMenuRevealed && !args.isMultiContext
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

export function shouldUseNativeContextMenu(target: EventTarget | null): boolean {
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

export function shouldIgnoreNestedWorktreeContextMenuScope(
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

export function shouldSuppressContextMenuFollowUpClick(
  contextMenuOpenedAt: number,
  now: number
): boolean {
  return (
    now - contextMenuOpenedAt >= 0 && now - contextMenuOpenedAt <= CONTEXT_MENU_CLICK_SUPPRESSION_MS
  )
}

export function getWorktreeParentPickerLabel(validParentWorktreeId: string | null): string {
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

export function isWorktreeParentPickerDisabled(args: {
  isDeleting: boolean
  eligibleParentCount: number
}): boolean {
  return args.isDeleting || args.eligibleParentCount === 0
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
  // Why: slow deletes leave the target row mounted; after initial focus/remount
  // settling, the restore loop must stop so user scrolling wins.
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

export type WorkspaceStatusAssignmentPlan =
  | { readonly kind: 'board-sync'; readonly worktreeIds: readonly string[] }
  | { readonly kind: 'local-only'; readonly localWriteIds: readonly string[] }

// Why: the context-menu "Move to Status" routes to the board's local-first +
// Linear-sync path when the board wired a callback, else a local-only write of
// only the status-changed worktrees. Extracted pure so the routing and the
// no-op filter stay unit-testable without opening the Radix menu.
export function planWorkspaceStatusAssignment(
  worktrees: readonly Worktree[],
  status: WorkspaceStatus,
  workspaceStatuses: readonly WorkspaceStatusDefinition[],
  boardSyncEnabled: boolean
): WorkspaceStatusAssignmentPlan {
  if (boardSyncEnabled) {
    return { kind: 'board-sync', worktreeIds: worktrees.map((item) => item.id) }
  }
  const localWriteIds = worktrees
    .filter((item) => getWorkspaceStatus(item, workspaceStatuses) !== status)
    .map((item) => item.id)
  return { kind: 'local-only', localWriteIds }
}
