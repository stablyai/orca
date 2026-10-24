import type { BrowserHistoryEntry } from '../../../../../shared/browser-workspace-types'
import type {
  BrowserSlice,
  BrowserSliceGet,
  BrowserSliceSet,
  RemovedBrowserHistory
} from './browser-slice-contract'
import type { WorkspaceDocHistoryEntry } from '../../../../../shared/workspace-doc-history'
import { redactKagiSessionToken } from '../../../../../shared/browser-url'
import {
  MAX_BROWSER_HISTORY_ENTRIES,
  normalizeBrowserHistoryUrl
} from '../../../../../shared/workspace-session-browser-history'
import {
  MAX_WORKSPACE_DOC_HISTORY_ENTRIES,
  normalizeWorkspaceDocHistoryEntries,
  normalizeWorkspaceDocHistoryTitle,
  workspaceDocHistoryEntriesEqual
} from '../../../../../shared/workspace-doc-history'
import { browserPageDocLocationsEqual } from '../../../../../shared/browser-page-doc-location'
import { ORCA_BROWSER_BLANK_URL } from '../../../../../shared/constants'

export function createBrowserHistoryActions(
  set: BrowserSliceSet,
  get: BrowserSliceGet
): Pick<
  BrowserSlice,
  | 'recordWorkspaceDocVisit'
  | 'addBrowserHistoryEntry'
  | 'removeBrowserHistoryEntry'
  | 'restoreBrowserHistory'
  | 'removeWorkspaceDocHistoryEntry'
  | 'clearBrowserHistory'
  | 'setBrowserHistoryPageId'
> {
  return {
    recordWorkspaceDocVisit: (docLocation, title, options) => {
      const bump = options?.bump ?? true
      set((s) => {
        const now = Date.now()
        const existing = s.workspaceDocHistory.find((entry) =>
          browserPageDocLocationsEqual(entry.docLocation, docLocation)
        )
        if (!existing && !bump) {
          // A title refresh for a document never visited records nothing.
          return s
        }
        const normalizedTitle = normalizeWorkspaceDocHistoryTitle(
          title ?? existing?.title,
          docLocation
        )
        const updated: WorkspaceDocHistoryEntry | null = existing
          ? {
              ...existing,
              title: normalizedTitle,
              ...(bump ? { lastVisitedAt: now, visitCount: existing.visitCount + 1 } : {})
            }
          : null
        // A repeated title-updated event from a live preview changes nothing; hand back the same
        // state so no subscriber re-renders. Over the cap the old path still had trimming to do.
        if (
          existing &&
          updated &&
          workspaceDocHistoryEntriesEqual(updated, existing) &&
          s.workspaceDocHistory.length <= MAX_WORKSPACE_DOC_HISTORY_ENTRIES
        ) {
          return s
        }
        const next: WorkspaceDocHistoryEntry[] = updated
          ? s.workspaceDocHistory.map((entry) => (entry === existing ? updated : entry))
          : [
              { docLocation, title: normalizedTitle, lastVisitedAt: now, visitCount: 1 },
              ...s.workspaceDocHistory
            ]
        return {
          workspaceDocHistory:
            next.length > MAX_WORKSPACE_DOC_HISTORY_ENTRIES
              ? normalizeWorkspaceDocHistoryEntries(next)
              : next
        }
      })
    },

    addBrowserHistoryEntry: (url, title, faviconUrl) => {
      const safeUrl = redactKagiSessionToken(url)
      if (safeUrl === ORCA_BROWSER_BLANK_URL || safeUrl === 'about:blank' || !safeUrl) {
        return
      }
      const normalized = normalizeBrowserHistoryUrl(safeUrl)
      set((s) => {
        const existing = s.browserUrlHistory.find((entry) => entry.normalizedUrl === normalized)
        let next: BrowserHistoryEntry[] = existing
          ? s.browserUrlHistory.map((entry) =>
              entry === existing
                ? {
                    ...entry,
                    title,
                    ...(faviconUrl !== undefined ? { faviconUrl } : {}),
                    lastVisitedAt: Date.now(),
                    visitCount: entry.visitCount + 1
                  }
                : entry
            )
          : [
              {
                url: safeUrl,
                normalizedUrl: normalized,
                title,
                ...(faviconUrl !== undefined ? { faviconUrl } : {}),
                lastVisitedAt: Date.now(),
                visitCount: 1
              },
              ...s.browserUrlHistory
            ]
        if (next.length > MAX_BROWSER_HISTORY_ENTRIES) {
          next = next
            .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
            .slice(0, MAX_BROWSER_HISTORY_ENTRIES)
        }
        return { browserUrlHistory: next }
      })
    },

    removeBrowserHistoryEntry: (normalizedUrl) => {
      const removed =
        get().browserUrlHistory.find((entry) => entry.normalizedUrl === normalizedUrl) ?? null
      if (removed) {
        set((s) => ({
          browserUrlHistory: s.browserUrlHistory.filter((entry) => entry !== removed)
        }))
      }
      return removed
    },

    restoreBrowserHistory: (removed) => {
      set((s) => {
        // A revisit between remove and Undo already re-created the row; keep the live one.
        const urls = removed.browserUrlHistory.filter(
          (entry) => !s.browserUrlHistory.some((live) => live.normalizedUrl === entry.normalizedUrl)
        )
        const docs = removed.workspaceDocHistory.filter(
          (entry) =>
            !s.workspaceDocHistory.some((live) =>
              browserPageDocLocationsEqual(live.docLocation, entry.docLocation)
            )
        )
        if (urls.length === 0 && docs.length === 0) {
          return s
        }
        return {
          browserUrlHistory: [...urls, ...s.browserUrlHistory],
          workspaceDocHistory: [...docs, ...s.workspaceDocHistory]
        }
      })
    },

    removeWorkspaceDocHistoryEntry: (docLocation) => {
      set((s) => ({
        workspaceDocHistory: s.workspaceDocHistory.filter(
          (entry) => !browserPageDocLocationsEqual(entry.docLocation, docLocation)
        )
      }))
    },

    // One clear for both sources: the dropdown presents them as one history.
    clearBrowserHistory: (since = -Infinity) => {
      const { browserUrlHistory, workspaceDocHistory } = get()
      const removed: RemovedBrowserHistory = {
        browserUrlHistory: browserUrlHistory.filter((entry) => entry.lastVisitedAt >= since),
        workspaceDocHistory: workspaceDocHistory.filter((entry) => entry.lastVisitedAt >= since)
      }
      set({
        browserUrlHistory: browserUrlHistory.filter((entry) => entry.lastVisitedAt < since),
        workspaceDocHistory: workspaceDocHistory.filter((entry) => entry.lastVisitedAt < since)
      })
      return removed
    },

    setBrowserHistoryPageId: (pageId) => set({ browserHistoryPageId: pageId })
  }
}
