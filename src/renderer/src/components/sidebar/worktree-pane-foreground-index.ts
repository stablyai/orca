import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'
import { parsePaneKey } from '../../../../shared/stable-pane-id'

type PaneForegroundIndexCache = {
  tabIdToWorktreeId: Map<string, string>
  paneForegroundAgentByPaneKey: Record<string, PaneForegroundAgentEntry>
  entriesByWorktree: Map<string, Record<string, PaneForegroundAgentEntry>>
}

let cache: PaneForegroundIndexCache | null = null

export function indexPaneForegroundAgentsByWorktree(
  tabIdToWorktreeId: Map<string, string>,
  paneForegroundAgentByPaneKey: Record<string, PaneForegroundAgentEntry>
): Map<string, Record<string, PaneForegroundAgentEntry>> {
  if (
    cache?.tabIdToWorktreeId === tabIdToWorktreeId &&
    cache.paneForegroundAgentByPaneKey === paneForegroundAgentByPaneKey
  ) {
    return cache.entriesByWorktree
  }

  const entriesByWorktree = new Map<string, Record<string, PaneForegroundAgentEntry>>()
  for (const [paneKey, entry] of Object.entries(paneForegroundAgentByPaneKey)) {
    const parsed = parsePaneKey(paneKey)
    const worktreeId = parsed ? tabIdToWorktreeId.get(parsed.tabId) : undefined
    if (!worktreeId) {
      continue
    }
    const bucket = entriesByWorktree.get(worktreeId) ?? {}
    bucket[paneKey] = entry
    entriesByWorktree.set(worktreeId, bucket)
  }
  for (const [worktreeId, entries] of entriesByWorktree) {
    entriesByWorktree.set(
      worktreeId,
      reuseRecordIfEqual(cache?.entriesByWorktree.get(worktreeId), entries)
    )
  }
  cache = { tabIdToWorktreeId, paneForegroundAgentByPaneKey, entriesByWorktree }
  return entriesByWorktree
}

function reuseRecordIfEqual<T>(
  previous: Record<string, T> | undefined,
  next: Record<string, T>
): Record<string, T> {
  const keys = Object.keys(next)
  if (!previous || Object.keys(previous).length !== keys.length) {
    return next
  }
  return keys.every((key) => previous[key] === next[key]) ? previous : next
}
