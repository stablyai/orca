import type { BrowserHistoryEntry } from '../../../../../shared/browser-workspace-types'
import type { BrowserSlice, BrowserSliceGet, BrowserSliceSet } from './browser-slice-contract'
import type { WorkspaceDocHistoryEntry } from '../../../../../shared/workspace-doc-history'
import { redactKagiSessionToken } from '../../../../../shared/browser-url'
import {
  MAX_BROWSER_HISTORY_ENTRIES,
  normalizeBrowserHistoryUrl
} from '../../../../../shared/workspace-session-browser-history'
import {
  MAX_WORKSPACE_DOC_HISTORY_ENTRIES,
  normalizeWorkspaceDocHistoryEntries,
  normalizeWorkspaceDocHistoryTitle
} from '../../../../../shared/workspace-doc-history'
import { browserPageDocLocationsEqual } from '../../../../../shared/browser-page-doc-location'
import { ORCA_BROWSER_BLANK_URL } from '../../../../../shared/constants'

export function createBrowserHistoryActions(
  set: BrowserSliceSet,
  _get: BrowserSliceGet
): Pick<
  BrowserSlice,
  'recordWorkspaceDocVisit' | 'addBrowserHistoryEntry' | 'clearBrowserHistory'
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
        const next: WorkspaceDocHistoryEntry[] = existing
          ? s.workspaceDocHistory.map((entry) =>
              entry === existing
                ? {
                    ...entry,
                    title: normalizedTitle,
                    ...(bump ? { lastVisitedAt: now, visitCount: entry.visitCount + 1 } : {})
                  }
                : entry
            )
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

    // One clear for both sources: the dropdown presents them as one history.
    clearBrowserHistory: () => set({ browserUrlHistory: [], workspaceDocHistory: [] })
  }
}
