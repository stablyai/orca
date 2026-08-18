import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { recordRendererCrashBreadcrumb } from '../../lib/crash-breadcrumb-recorder'

const reportedDuplicateTabVerdicts = new Set<string>()
// Why capped: this set is never pruned and each tab id adds up to two verdict
// keys. 256 keys cover 128–256 duplicated ids, enough evidence for a bundle.
const MAX_REPORTED_DUPLICATE_TAB_VERDICTS = 256

/** Test seam: the duplicate breadcrumb is once-per-tab-id-per-verdict per session. */
export function _resetDuplicateTabOwnerBreadcrumbsForTests(): void {
  reportedDuplicateTabVerdicts.clear()
}

/**
 * Resolve which worktree owns a terminal tab, preferring the active worktree.
 *
 * Why the preference: a stale map can leave one tab id under two worktrees, and
 * attributing it to an arbitrary first match leaves `activeTabId` permanently
 * unconvergeable — which strands Terminal's active-terminal repair effect in a
 * self-retriggering loop (React #185).
 */
export function resolveActiveTabOwnerWorktreeId(
  tabsByWorktree: Record<string, TerminalTab[]>,
  activeWorktreeId: string | null,
  tabId: string
): string | null {
  let firstOwnerId: string | null = null
  let ownerCount = 0
  // Why tracked in-loop rather than re-read by key: `tabsByWorktree[activeWorktreeId]`
  // resolves inherited members for ids like `toString`, and `?.some` would then throw.
  // Why the id and not a boolean: a falsy-but-valid active id ('') would fail a
  // truthiness guard below and silently fall back to the first match — the very
  // misattribution this function exists to remove.
  let activeOwnerId: string | null = null
  // Why keys and not entries: entries allocates a pair array per worktree on a path
  // that runs per tab activation. Own keys stay safe to index by.
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

  // Why breadcrumb: hydration can retain duplicates after a worktree id change,
  // but current field reports predate this signal.
  // Reading it: `ownerCount > 1` is the load-bearing datum; the verdict only
  // hints at the caller. A sustained repair loop shows up as `true`, since that
  // effect picks from the active worktree's own list — but it does not prove the
  // caller, and the repair effect can emit `false` too: its closure holds the
  // worktree from its render while this runs against live state, so a worktree
  // switch landing in between (an earlier-flushed effect, or IPC before the
  // passive flush) reattributes the tab. So `false` covers that race as well as
  // a deliberate background activation such as jump-to-agent — discard neither.
  // Why the verdict is in the guard key: it flips under a persisting duplicate,
  // and coalescing keeps only the newest payload, so one would erase the other.
  // Still at most two crumbs per tab id.
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
