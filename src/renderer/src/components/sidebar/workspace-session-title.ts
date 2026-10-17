import type { Tab } from '../../../../shared/tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { resolveUnifiedTabLabel } from '../../../../shared/tab-title-resolution'
import { isUnifiedTabOwnedByWorktree } from '@/lib/unified-tab-host-ownership'

const NO_AMBIGUOUS_IDS: ReadonlySet<string> = new Set()

/** Stable session names describe the task; shell/OSC status updates must not rename the workspace. */
export function getWorkspaceSessionTitle(
  worktree: Worktree,
  tabs: readonly Tab[],
  generatedTitlesEnabled: boolean,
  ambiguousWorktreeId = false
): string | undefined {
  const ambiguousIds = ambiguousWorktreeId ? new Set([worktree.id]) : NO_AMBIGUOUS_IDS
  let title: string | undefined
  let latestFocus = -Infinity
  for (const tab of tabs) {
    if (
      (tab.contentType !== 'terminal' && tab.contentType !== 'agent-session') ||
      !isUnifiedTabOwnedByWorktree(tab, worktree, ambiguousIds)
    ) {
      continue
    }
    const candidate = resolveUnifiedTabLabel(
      { ...tab, label: '', quickCommandLabel: null },
      generatedTitlesEnabled
    )
    const focusedAt = tab.lastFocusedAt ?? tab.createdAt
    if (candidate && focusedAt > latestFocus) {
      title = candidate
      latestFocus = focusedAt
    }
  }
  return title
}
