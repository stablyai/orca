import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { recordRendererCrashBreadcrumb } from '../../lib/crash-breadcrumb-recorder'

const reportedDuplicateTabVerdicts = new Set<string>()
// Bound never-pruned verdict keys: 256 covers evidence for 128–256 duplicate tab IDs.
const MAX_REPORTED_DUPLICATE_TAB_VERDICTS = 256

/** Test seam: the duplicate breadcrumb is once-per-tab-id-per-verdict per session. */
export function _resetDuplicateTabOwnerBreadcrumbsForTests(): void {
  reportedDuplicateTabVerdicts.clear()
}

/** Prefer active-worktree matches for duplicate tab IDs; arbitrary first ownership prevents activeTabId repair converging and loops React #185. */
export function resolveActiveTabOwnerWorktreeId(
  tabsByWorktree: Record<string, TerminalTab[]>,
  activeWorktreeId: string | null,
  tabId: string
): string | null {
  let firstOwnerId: string | null = null
  let ownerCount = 0
  // Find during own-key iteration; direct indexing resolves inherited toString and can throw on some().
  // Preserve falsy-but-valid active IDs, including empty string, instead of falling back to first match.
  let activeOwnerId: string | null = null
  // Own keys avoid per-worktree pair allocations on every activation while retaining safe indexing.
  for (const worktreeId of Object.keys(tabsByWorktree)) {
    const tabs = tabsByWorktree[worktreeId]
    if (!tabs.some((tab) => tab.id === tabId)) {
      continue
    }
    ownerCount += 1
    if (firstOwnerId === null) {
      firstOwnerId = worktreeId
    }
    if (worktreeId === activeWorktreeId) {
      activeOwnerId = worktreeId
    }
  }

  // Report duplicate ownerCount after hydration. Verdict only hints at caller: repair can read changed live workspace versus rendered closure, so false covers races and deliberate background activation. Keep both verdicts in dedupe keys or coalescing erases evidence; at most two crumbs per tab ID.
  const resolvedToActiveWorktree = activeOwnerId !== null
  const verdictKey = `${tabId}:${resolvedToActiveWorktree}`
  if (
    ownerCount > 1 &&
    !reportedDuplicateTabVerdicts.has(verdictKey) &&
    reportedDuplicateTabVerdicts.size < MAX_REPORTED_DUPLICATE_TAB_VERDICTS
  ) {
    reportedDuplicateTabVerdicts.add(verdictKey)
    recordRendererCrashBreadcrumb('terminal_tab_id_owned_by_multiple_worktrees', {
      ownerCount,
      resolvedToActiveWorktree
    })
  }

  if (ownerCount > 1 && activeOwnerId !== null) {
    return activeOwnerId
  }
  return firstOwnerId
}
