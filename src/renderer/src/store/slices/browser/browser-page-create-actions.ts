import type {
  BrowserSlice,
  BrowserSliceGet,
  BrowserSliceSet,
  RemoteBrowserPageHandle
} from './browser-slice-contract'
import {
  buildBrowserPage,
  findPage,
  findWorkspace,
  mirrorWorkspaceFromActivePage
} from '../browser-page-records'
import { ORCA_BROWSER_BLANK_URL } from '../../../../../shared/constants'
import { closeRemoteBrowserPageInOwningEnvironment } from './browser-remote-close'
import { releaseDocPreviewGrant } from '@/lib/doc-preview-grants'

export function createBrowserPageCreateActions(
  set: BrowserSliceSet,
  get: BrowserSliceGet
): Pick<BrowserSlice, 'createBrowserPage' | 'closeBrowserPage'> {
  return {
    createBrowserPage: (workspaceId, url, options) => {
      const workspace = findWorkspace(get().browserTabsByWorktree, workspaceId)
      if (!workspace) {
        return null
      }
      const page = buildBrowserPage(
        workspaceId,
        workspace.worktreeId,
        url,
        options?.title,
        options?.browserRuntimeEnvironmentId,
        undefined,
        options?.docLocation
      )

      set((s) => {
        const pages = s.browserPagesByWorkspace[workspaceId] ?? []
        const shouldActivate = options?.activate ?? true
        const nextPages = [...pages, page]
        const nextWorkspace = mirrorWorkspaceFromActivePage(
          {
            ...workspace,
            activePageId: shouldActivate ? page.id : (workspace.activePageId ?? page.id),
            pageIds: nextPages.map((entry) => entry.id)
          },
          nextPages
        )
        const shouldUpdateGlobalActiveSurface =
          shouldActivate &&
          s.activeWorktreeId === workspace.worktreeId &&
          s.activeBrowserTabIdByWorktree[workspace.worktreeId] === workspaceId
        const shouldFocusAddressBar =
          shouldUpdateGlobalActiveSurface &&
          !page.docLocation &&
          (page.url === 'about:blank' || page.url === ORCA_BROWSER_BLANK_URL)

        return {
          browserPagesByWorkspace: {
            ...s.browserPagesByWorkspace,
            [workspaceId]: nextPages
          },
          browserTabsByWorktree: {
            ...s.browserTabsByWorktree,
            [workspace.worktreeId]: (s.browserTabsByWorktree[workspace.worktreeId] ?? []).map(
              (tab) => (tab.id === workspaceId ? nextWorkspace : tab)
            )
          },
          pendingAddressBarFocusByPageId: shouldFocusAddressBar
            ? {
                ...s.pendingAddressBarFocusByPageId,
                [page.id]: true
              }
            : s.pendingAddressBarFocusByPageId,
          pendingAddressBarFocusByTabId: shouldFocusAddressBar
            ? {
                ...s.pendingAddressBarFocusByTabId,
                [page.id]: true
              }
            : s.pendingAddressBarFocusByTabId
        }
      })

      const nextWorkspace = findWorkspace(get().browserTabsByWorktree, workspaceId)
      if (nextWorkspace?.activePageId === page.id) {
        const item = Object.values(get().unifiedTabsByWorktree)
          .flat()
          .find((entry) => entry.contentType === 'browser' && entry.entityId === workspaceId)
        if (item) {
          get().setTabLabel(item.id, page.title)
        }
      }
      return page
    },

    closeBrowserPage: (pageId) => {
      let closedWorkspaceIdForLabel: string | null = null
      let docPageIdToRelease: string | null = null
      const remotePagesToClose: { worktreeId: string; handle: RemoteBrowserPageHandle }[] = []
      set((s) => {
        const page = findPage(s.browserPagesByWorkspace, pageId)
        if (!page) {
          return s
        }
        const workspace = findWorkspace(s.browserTabsByWorktree, page.workspaceId)
        if (!workspace) {
          return s
        }
        closedWorkspaceIdForLabel = page.workspaceId
        docPageIdToRelease = page.docLocation ? page.id : null
        const currentPages = s.browserPagesByWorkspace[workspace.id] ?? []
        const nextPages = currentPages.filter((entry) => entry.id !== pageId)
        const closedIdx = currentPages.findIndex((entry) => entry.id === pageId)
        const nextActivePageId =
          workspace.activePageId === pageId
            ? ((nextPages[closedIdx] ?? nextPages[closedIdx - 1] ?? null)?.id ?? null)
            : workspace.activePageId
        const nextWorkspace = mirrorWorkspaceFromActivePage(
          {
            ...workspace,
            activePageId: nextActivePageId,
            pageIds: nextPages.map((entry) => entry.id)
          },
          nextPages
        )
        const remoteHandle = s.remoteBrowserPageHandlesByPageId[pageId]
        if (remoteHandle) {
          remotePagesToClose.push({ worktreeId: page.worktreeId, handle: remoteHandle })
        }
        const nextRemoteBrowserPageHandlesByPageId = {
          ...s.remoteBrowserPageHandlesByPageId
        }
        delete nextRemoteBrowserPageHandlesByPageId[pageId]
        const nextBrowserAnnotationsByPageId = { ...s.browserAnnotationsByPageId }
        delete nextBrowserAnnotationsByPageId[pageId]
        const nextBrowserCertificateFailuresByPageId = {
          ...s.browserCertificateFailuresByPageId
        }
        delete nextBrowserCertificateFailuresByPageId[pageId]

        return {
          browserPagesByWorkspace: {
            ...s.browserPagesByWorkspace,
            [workspace.id]: nextPages
          },
          browserTabsByWorktree: {
            ...s.browserTabsByWorktree,
            [workspace.worktreeId]: (s.browserTabsByWorktree[workspace.worktreeId] ?? []).map(
              (tab) => (tab.id === workspace.id ? nextWorkspace : tab)
            )
          },
          recentlyClosedBrowserPagesByWorkspace: {
            ...s.recentlyClosedBrowserPagesByWorkspace,
            [workspace.id]: [
              page,
              ...(s.recentlyClosedBrowserPagesByWorkspace[workspace.id] ?? []).filter(
                (entry) => entry.id !== page.id
              )
            ].slice(0, 10)
          },
          pendingAddressBarFocusByPageId: Object.fromEntries(
            Object.entries(s.pendingAddressBarFocusByPageId).filter(
              ([pendingPageId]) => pendingPageId !== pageId
            )
          ),
          pendingAddressBarFocusByTabId: Object.fromEntries(
            Object.entries(s.pendingAddressBarFocusByTabId).filter(
              ([pendingPageId]) => pendingPageId !== pageId
            )
          ),
          remoteBrowserPageHandlesByPageId: nextRemoteBrowserPageHandlesByPageId,
          browserCertificateFailuresByPageId: nextBrowserCertificateFailuresByPageId,
          browserAnnotationsByPageId: nextBrowserAnnotationsByPageId
        }
      })

      for (const remotePage of remotePagesToClose) {
        closeRemoteBrowserPageInOwningEnvironment(
          remotePage.worktreeId,
          remotePage.handle,
          get().recordClientHostedBrowserCloseIntents
        )
      }

      if (docPageIdToRelease) {
        releaseDocPreviewGrant(docPageIdToRelease)
      }

      const closedWorkspaceId = closedWorkspaceIdForLabel
      if (!closedWorkspaceId) {
        return
      }
      const workspace = findWorkspace(get().browserTabsByWorktree, closedWorkspaceId)
      const item = Object.values(get().unifiedTabsByWorktree)
        .flat()
        .find((entry) => entry.contentType === 'browser' && entry.entityId === closedWorkspaceId)
      if (item && workspace) {
        get().setTabLabel(item.id, workspace.title)
      }
    }
  }
}
