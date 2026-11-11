import type { WorkspaceSessionTitleUpdate } from '../../../../../shared/workspace-session/workspace-session-terminal-titles'
import { isDecorativeAgentTitleFrameChange } from '../../../../../shared/agent-status/title/agent-decorative-title-signature'

export function collectTitleUpdates<T extends { id: string }>(
  previous: Record<string, T[]>,
  next: Record<string, T[]>,
  changedBeyondTitle: (previous: T, next: T) => boolean,
  title: (tab: T) => string
): WorkspaceSessionTitleUpdate[] | null {
  if (Object.keys(previous).length !== Object.keys(next).length) {
    return null
  }
  const updates: WorkspaceSessionTitleUpdate[] = []
  for (const worktreeId of Object.keys(next)) {
    const before = previous[worktreeId]
    const after = next[worktreeId]
    if (before === after) {
      continue
    }
    if (!before || before.length !== after.length) {
      return null
    }
    for (let index = 0; index < after.length; index += 1) {
      const prevTab = before[index]
      const nextTab = after[index]
      if (prevTab === nextTab) {
        continue
      }
      if (prevTab.id !== nextTab.id || changedBeyondTitle(prevTab, nextTab)) {
        return null
      }
      const prevTitle = title(prevTab)
      const nextTitle = title(nextTab)
      if (prevTitle !== nextTitle && !isDecorativeAgentTitleFrameChange(prevTitle, nextTitle)) {
        updates.push({ worktreeId, tabId: nextTab.id, value: nextTitle })
      }
    }
  }
  return updates
}
