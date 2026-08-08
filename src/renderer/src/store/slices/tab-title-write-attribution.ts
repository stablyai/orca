import { recordRendererCrashBreadcrumb } from '../../lib/crash-breadcrumb-recorder'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree-id'
import type { TerminalTab } from '../../../../shared/types'

/** Which title-writing path made the call; distinguishes the contextful callers in a bundle. */
export type TerminalTabTitleWriteSite =
  | 'parked-byte-watcher'
  | 'pty-title-change'
  | 'pty-inferred-interrupt-clear'
  | 'pty-confirmed-shell-clear'
  | 'ipc-agent-status-title'
  | 'pane-focus-sync'
  | 'pane-closed'

/**
 * What the writer knows about itself, so the store can check its own owner lookup against it.
 * Diagnostic only: nothing here changes what the write does.
 */
export type TerminalTabTitleWriteContext = {
  worktreeId: string
  site: TerminalTabTitleWriteSite
}

const reportedTitleWriteMismatches = new Set<string>()
// Why capped: this set is never pruned and one key is added per distinct
// tab/expected/owner/site combination. 256 is ample evidence for a bundle.
const MAX_REPORTED_TITLE_WRITE_MISMATCHES = 256

/** Test seam: the mismatch breadcrumb is once-per-combination per session. */
export function _resetTabTitleWriteAttributionBreadcrumbsForTests(): void {
  reportedTitleWriteMismatches.clear()
}

function countWorktreesOwningTab(
  tabsByWorktree: Record<string, TerminalTab[]>,
  tabId: string
): number {
  let owners = 0
  for (const tabs of Object.values(tabsByWorktree)) {
    if (tabs.some((tab) => tab.id === tabId)) {
      owners += 1
    }
  }
  return owners
}

/**
 * Breadcrumb a title write whose writer worktree disagrees with the store's owner lookup.
 *
 * Why: a title from worktree A briefly landing on a tab shown for worktree B is
 * reported but unexplained, and no existing trace records title writes at all.
 * The writer already knows its own worktree; the store re-derives one from the
 * tab id alone. This is the exact moment those two disagree.
 *
 * Raw worktree and pty ids are deliberately not carried: the crash sanitizer
 * collapses every absolute path to one literal, so two worktrees of a repo
 * arrive byte-identical. `ownerCount` and `sameRepo` separate a tab id
 * duplicated across buckets from a writer holding a stale worktree id, and the
 * opaque tab id survives intact. Titles are never carried — they can contain
 * agent prompt text and crash bundles leave the device.
 */
export function recordTabTitleWriteWorktreeMismatch(args: {
  tabId: string
  ownerWorktreeId: string
  tabsByWorktree: Record<string, TerminalTab[]>
  context: TerminalTabTitleWriteContext | undefined
}): void {
  const { context, tabId, ownerWorktreeId } = args
  if (!context || context.worktreeId === ownerWorktreeId) {
    return
  }

  const mismatchKey = `${tabId}:${context.worktreeId}:${ownerWorktreeId}:${context.site}`
  if (
    reportedTitleWriteMismatches.has(mismatchKey) ||
    reportedTitleWriteMismatches.size >= MAX_REPORTED_TITLE_WRITE_MISMATCHES
  ) {
    return
  }
  reportedTitleWriteMismatches.add(mismatchKey)

  recordRendererCrashBreadcrumb('terminal_tab_title_write_worktree_mismatch', {
    tabId,
    site: context.site,
    ownerCount: countWorktreesOwningTab(args.tabsByWorktree, tabId),
    sameRepo:
      getRepoIdFromWorktreeId(context.worktreeId) === getRepoIdFromWorktreeId(ownerWorktreeId)
  })
}
