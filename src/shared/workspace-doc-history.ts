import { browserPageDocLocationsEqual } from './browser-page-doc-location'
import type { BrowserPageDocLocation } from './browser-workspace-types'
import { isDocPreviewUrl } from './doc-preview-scheme'

/**
 * A previewed workspace document the URL-bar dropdown can offer again. The document is the whole
 * identity — there is deliberately no url field, so the grant URL a preview is served over has
 * nowhere to land in history: confinement by absence, like the registry split.
 */
export type WorkspaceDocHistoryEntry = {
  docLocation: BrowserPageDocLocation
  title: string
  lastVisitedAt: number
  visitCount: number
}

export const MAX_WORKSPACE_DOC_HISTORY_ENTRIES = 100

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
  const candidates = [...entries].sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
  for (const entry of candidates) {
    if (
      entry.docLocation?.kind !== 'workspace-doc' ||
      !entry.docLocation.worktreeId ||
      !entry.docLocation.filePath
    ) {
      continue
    }
    if (
      normalized.some((kept) => browserPageDocLocationsEqual(kept.docLocation, entry.docLocation))
    ) {
      continue
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
