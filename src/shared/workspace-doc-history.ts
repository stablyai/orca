import type { BrowserPageDocLocation } from './browser-workspace-types'
import { isDocPreviewUrl } from './doc-preview-scheme'

/** Persist document identity only; omitting URL gives preview grant URLs no place in history. */
export type WorkspaceDocHistoryEntry = {
  docLocation: BrowserPageDocLocation
  title: string
  lastVisitedAt: number
  visitCount: number
}

export const MAX_WORKSPACE_DOC_HISTORY_ENTRIES = 100

/** Compare actual keys so future fields cannot bypass unchanged-entry checks. */
export function workspaceDocHistoryEntriesEqual(
  left: WorkspaceDocHistoryEntry,
  right: WorkspaceDocHistoryEntry
): boolean {
  const leftKeys = Object.keys(left) as (keyof WorkspaceDocHistoryEntry)[]
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => Object.is(left[key], right[key]))
  )
}

/** The title fence the page store applies, for history rows: a url-as-title falls back to the file. */
export function normalizeWorkspaceDocHistoryTitle(
  title: string | null | undefined,
  docLocation: BrowserPageDocLocation
): string {
  if (!title || isDocPreviewUrl(title)) {
    const fileName = docLocation.filePath.split(/[\\/]/).at(-1)
    return fileName || docLocation.filePath
  }
  return title
}

export function normalizeWorkspaceDocHistoryEntries(
  entries: readonly WorkspaceDocHistoryEntry[]
): WorkspaceDocHistoryEntry[] {
  const normalized: WorkspaceDocHistoryEntry[] = []
  const seenPathsByWorktree = new Map<string, Set<string>>()
  const candidates = [...entries].sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
  for (const entry of candidates) {
    if (
      entry.docLocation?.kind !== 'workspace-doc' ||
      !entry.docLocation.worktreeId ||
      !entry.docLocation.filePath
    ) {
      continue
    }
    // Nest workspace/path maps to avoid delimiter collisions; keep equivalent to browserPageDocLocationsEqual or dedupe creates duplicate history rows.
    const { worktreeId, filePath } = entry.docLocation
    const seenPaths = seenPathsByWorktree.get(worktreeId)
    if (seenPaths?.has(filePath)) {
      continue
    }
    if (seenPaths) {
      seenPaths.add(filePath)
    } else {
      seenPathsByWorktree.set(worktreeId, new Set([filePath]))
    }
    normalized.push({
      ...entry,
      title: normalizeWorkspaceDocHistoryTitle(entry.title, entry.docLocation)
    })
    if (normalized.length >= MAX_WORKSPACE_DOC_HISTORY_ENTRIES) {
      break
    }
  }
  return normalized
}
