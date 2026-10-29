import { editSessionSource, type OrdinarySourcePartial } from '@/store/session-source-edits'
import type { BrowserSlice, BrowserSliceGet, BrowserSliceSet } from './browser-slice-contract'
import type { AppState } from '../../types'
import { ORCA_BROWSER_BLANK_URL } from '../../../../../shared/constants'
import {
  browserWorkspaceMirrorFieldsEqual,
  findPage,
  findWorkspace,
  mirrorWorkspaceFromActivePage,
  normalizeBrowserTitle,
  normalizeUrl
} from '../browser-page-records'
import { normalizeBrowserHistoryUrl } from '../../../../../shared/workspace-session-browser-history'

export function createBrowserPageStateActions(
  set: BrowserSliceSet,
  get: BrowserSliceGet
): Pick<
  BrowserSlice,
  | 'updateBrowserTabPageState'
  | 'updateBrowserPageState'
  | 'setBrowserPageCertificateFailure'
  | 'setBrowserTabUrl'
  | 'setBrowserPageUrl'
> {
  return {
    updateBrowserTabPageState: (pageId, updates) => get().updateBrowserPageState(pageId, updates),

    updateBrowserPageState: (pageId, updates) => {
      set((s) => {
        const page = findPage(s.browserPagesByWorkspace, pageId)
        if (!page) {
          return undefined
        }
        const workspace = findWorkspace(s.browserTabsByWorktree, page.workspaceId)
        if (!workspace) {
          return undefined
        }
        const nextPage = {
          ...page,
          title:
            updates.title === undefined
              ? page.title
              : normalizeBrowserTitle(updates.title, page.url, page.docLocation),
          loading: updates.loading ?? page.loading,
          faviconUrl: updates.faviconUrl === undefined ? page.faviconUrl : updates.faviconUrl,
          canGoBack: updates.canGoBack ?? page.canGoBack,
          canGoForward: updates.canGoForward ?? page.canGoForward,
          loadError: updates.loadError === undefined ? page.loadError : updates.loadError
        }
        const unifiedTabs = s.unifiedTabsByWorktree[workspace.worktreeId] ?? []
        const unifiedIndex =
          workspace.activePageId === pageId && updates.title !== undefined
            ? unifiedTabs.findIndex(
                (entry) => entry.contentType === 'browser' && entry.entityId === workspace.id
              )
            : -1
        const unifiedLabelNeedsRepair =
          unifiedIndex !== -1 && unifiedTabs[unifiedIndex]?.label !== nextPage.title
        const pageStateUnchanged =
          nextPage.title === page.title &&
          nextPage.loading === page.loading &&
          nextPage.faviconUrl === page.faviconUrl &&
          nextPage.canGoBack === page.canGoBack &&
          nextPage.canGoForward === page.canGoForward &&
          nextPage.loadError === page.loadError
        const currentPages = s.browserPagesByWorkspace[workspace.id] ?? []
        const mirroredWorkspace = pageStateUnchanged
          ? mirrorWorkspaceFromActivePage(workspace, currentPages)
          : null
        const workspaceNeedsRepair =
          mirroredWorkspace !== null &&
          !browserWorkspaceMirrorFieldsEqual(workspace, mirroredWorkspace)
        if (pageStateUnchanged && !unifiedLabelNeedsRepair && !workspaceNeedsRepair) {
          return undefined
        }
        const edit = editSessionSource(s)
        if (pageStateUnchanged) {
          if (workspaceNeedsRepair && mirroredWorkspace) {
            edit.set(
              'browserTabsByWorktree',
              workspace.worktreeId,
              (s.browserTabsByWorktree[workspace.worktreeId] ?? []).map((tab) =>
                tab.id === workspace.id ? mirroredWorkspace : tab
              )
            )
          }
          if (unifiedLabelNeedsRepair) {
            edit.set(
              'unifiedTabsByWorktree',
              workspace.worktreeId,
              unifiedTabs.map((entry, index) =>
                index === unifiedIndex ? { ...entry, label: nextPage.title } : entry
              )
            )
          }
          return edit.finish()
        }
        const nextPages = currentPages.map((entry) => (entry.id === pageId ? nextPage : entry))
        const nextWorkspace = mirrorWorkspaceFromActivePage(workspace, nextPages)
        edit.set('browserPagesByWorkspace', workspace.id, nextPages)
        const nextState: OrdinarySourcePartial<AppState> = {}
        if (updates.faviconUrl !== undefined && updates.faviconUrl !== page.faviconUrl) {
          const historyIndex = s.browserUrlHistory.findIndex(
            (entry) => entry.normalizedUrl === normalizeBrowserHistoryUrl(page.url)
          )
          const historyEntry = s.browserUrlHistory[historyIndex]
          if (historyEntry && historyEntry.faviconUrl !== updates.faviconUrl) {
            nextState.browserUrlHistory = s.browserUrlHistory.map((entry, index) =>
              index === historyIndex ? { ...entry, faviconUrl: updates.faviconUrl } : entry
            )
          }
        }
        if (!browserWorkspaceMirrorFieldsEqual(workspace, nextWorkspace)) {
          edit.set(
            'browserTabsByWorktree',
            workspace.worktreeId,
            (s.browserTabsByWorktree[workspace.worktreeId] ?? []).map((tab) =>
              tab.id === workspace.id ? nextWorkspace : tab
            )
          )
        }
        if (
          workspace.activePageId === pageId &&
          updates.title !== undefined &&
          unifiedIndex !== -1
        ) {
          if (unifiedLabelNeedsRepair || unifiedTabs[unifiedIndex]?.label !== nextWorkspace.title) {
            edit.set(
              'unifiedTabsByWorktree',
              workspace.worktreeId,
              unifiedTabs.map((entry, index) =>
                index === unifiedIndex ? { ...entry, label: nextWorkspace.title } : entry
              )
            )
          }
        }
        return edit.finish(nextState)
      })
      if (updates.loadError === null) {
        get().setBrowserPageCertificateFailure(pageId, null)
      }
    },

    setBrowserPageCertificateFailure: (pageId, failure) => {
      set((s) => {
        const current = s.browserCertificateFailuresByPageId[pageId]
        if (failure === null) {
          if (!current) {
            return undefined
          }
          const nextFailures = { ...s.browserCertificateFailuresByPageId }
          delete nextFailures[pageId]
          return { browserCertificateFailuresByPageId: nextFailures }
        }
        if (!findPage(s.browserPagesByWorkspace, pageId) || current === failure) {
          return undefined
        }
        return {
          browserCertificateFailuresByPageId: {
            ...s.browserCertificateFailuresByPageId,
            [pageId]: failure
          }
        }
      })
    },

    setBrowserTabUrl: (pageId, url) => get().setBrowserPageUrl(pageId, url),

    setBrowserPageUrl: (pageId, url, options) => {
      const nextUrl = normalizeUrl(url)
      if (nextUrl !== 'about:blank' && nextUrl !== ORCA_BROWSER_BLANK_URL) {
        const currentPage = findPage(get().browserPagesByWorkspace, pageId)
        if (currentPage) {
          get().recordFeatureInteraction?.('browser')
        }
      }
      set((s) => {
        const page = findPage(s.browserPagesByWorkspace, pageId)
        if (!page) {
          return undefined
        }
        const workspace = findWorkspace(s.browserTabsByWorktree, page.workspaceId)
        if (!workspace) {
          return undefined
        }
        // Keep document URL blank at navigation sink too; committing grants here leaks to persistence, publication and address bar.
        const nextPageUrl = page.docLocation ? ORCA_BROWSER_BLANK_URL : nextUrl
        const nextPages = (s.browserPagesByWorkspace[workspace.id] ?? []).map((entry) =>
          entry.id === pageId
            ? {
                ...entry,
                url: nextPageUrl,
                title: normalizeBrowserTitle(entry.title, nextPageUrl, entry.docLocation),
                // Document guests are inert; loading=true would never clear.
                loading: !entry.docLocation,
                loadError: options?.preserveLoadError ? entry.loadError : null
              }
            : entry
        )
        const nextWorkspace = mirrorWorkspaceFromActivePage(workspace, nextPages)
        return editSessionSource(s)
          .set('browserPagesByWorkspace', workspace.id, nextPages)
          .set(
            'browserTabsByWorktree',
            workspace.worktreeId,
            (s.browserTabsByWorktree[workspace.worktreeId] ?? []).map((tab) =>
              tab.id === workspace.id ? nextWorkspace : tab
            )
          )
          .finish({})
      })
      get().setBrowserPageCertificateFailure(pageId, null)
    }
  }
}
