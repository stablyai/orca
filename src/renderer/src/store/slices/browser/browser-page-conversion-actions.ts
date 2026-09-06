import type {
  BrowserSlice,
  BrowserSliceGet,
  BrowserSliceSet,
  RemoteBrowserPageHandle
} from './browser-slice-contract'
import type { BrowserPage } from '../../../../../shared/browser-workspace-types'
import { planBrowserPageConversion } from '../browser-page-conversion'
import { findPage, findWorkspace, mirrorWorkspaceFromActivePage } from '../browser-page-records'
import { assertManagedBrowserMaterializationAllowed } from '@/lib/client-creation-action-policy'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { closeRemoteBrowserPageInOwningEnvironment } from './browser-remote-close'
import { releaseDocPreviewGrant } from '@/lib/doc-preview-grants'
import { isLocalBrowserPageOwner } from './browser-host-state'

export function createBrowserPageConversionActions(
  set: BrowserSliceSet,
  get: BrowserSliceGet
): Pick<BrowserSlice, 'convertBrowserPage' | 'reopenClosedBrowserPage' | 'setActiveBrowserPage'> {
  return {
    convertBrowserPage: (pageId, target, options) => {
      // Why the same assert as createBrowserTab: a conversion materializes a browser surface the
      // same way a creation does, and a paired web client that cannot host one must refuse here too.
      // Ownership is resolved ONCE, on the plan's own terms — property-present-undefined means
      // worktree-inferred — so the assert and the plan cannot disagree about what is being built.
      const oldPageForOwnership = findPage(get().browserPagesByWorkspace, pageId)
      const declaredOwnership =
        target.kind === 'workspace-doc'
          ? null
          : 'browserRuntimeEnvironmentId' in target
            ? target.browserRuntimeEnvironmentId
            : (oldPageForOwnership?.browserRuntimeEnvironmentId ?? null)
      assertManagedBrowserMaterializationAllowed(
        get(),
        declaredOwnership !== undefined
          ? declaredOwnership
          : oldPageForOwnership
            ? (getRuntimeEnvironmentIdForWorktree(get(), oldPageForOwnership.worktreeId) ?? null)
            : null
      )
      let converted: BrowserPage | null = null
      let docPageIdToRelease: string | null = null
      let remotePageToClose: { worktreeId: string; handle: RemoteBrowserPageHandle } | null = null
      set((s) => {
        const plan = planBrowserPageConversion(s, pageId, target, options)
        if (!plan) {
          return s
        }
        converted = plan.newPage
        // Why collected rather than released inside the reducer: revoking is main-process work, and
        // it must happen exactly once even if a later set() retries the reducer.
        if (plan.oldPage.docLocation) {
          docPageIdToRelease = plan.oldPage.id
        }
        const remoteHandle = s.remoteBrowserPageHandlesByPageId[plan.oldPage.id]
        if (remoteHandle) {
          remotePageToClose = { worktreeId: plan.oldPage.worktreeId, handle: remoteHandle }
        }
        const nextRemoteBrowserPageHandlesByPageId = { ...s.remoteBrowserPageHandlesByPageId }
        delete nextRemoteBrowserPageHandlesByPageId[plan.oldPage.id]
        const nextBrowserAnnotationsByPageId = { ...s.browserAnnotationsByPageId }
        delete nextBrowserAnnotationsByPageId[plan.oldPage.id]
        const nextBrowserCertificateFailuresByPageId = { ...s.browserCertificateFailuresByPageId }
        delete nextBrowserCertificateFailuresByPageId[plan.oldPage.id]
        return {
          browserPagesByWorkspace: {
            ...s.browserPagesByWorkspace,
            [plan.workspace.id]: plan.nextPages
          },
          browserTabsByWorktree: {
            ...s.browserTabsByWorktree,
            [plan.workspace.worktreeId]: (
              s.browserTabsByWorktree[plan.workspace.worktreeId] ?? []
            ).map((tab) => (tab.id === plan.workspace.id ? plan.nextWorkspace : tab))
          },
          pendingAddressBarFocusByPageId: Object.fromEntries(
            Object.entries(s.pendingAddressBarFocusByPageId).filter(
              ([pendingPageId]) => pendingPageId !== plan.oldPage.id
            )
          ),
          pendingAddressBarFocusByTabId: Object.fromEntries(
            Object.entries(s.pendingAddressBarFocusByTabId).filter(
              ([pendingPageId]) => pendingPageId !== plan.oldPage.id
            )
          ),
          remoteBrowserPageHandlesByPageId: nextRemoteBrowserPageHandlesByPageId,
          browserCertificateFailuresByPageId: nextBrowserCertificateFailuresByPageId,
          browserAnnotationsByPageId: nextBrowserAnnotationsByPageId
        }
      })
      // Why the casts: the assignments happen inside set()'s callback, which TS's flow analysis does
      // not track, so the initializers' null narrowing would otherwise read these as never.
      const newPage = converted as BrowserPage | null
      const remoteClose = remotePageToClose as {
        worktreeId: string
        handle: RemoteBrowserPageHandle
      } | null
      if (!newPage) {
        return null
      }
      if (remoteClose) {
        closeRemoteBrowserPageInOwningEnvironment(
          remoteClose.worktreeId,
          remoteClose.handle,
          get().recordClientHostedBrowserCloseIntents
        )
      }
      // Why after the reducer: a closed document must stop being readable, and the grant is the only
      // authority the preview scheme honors — but the store row has to stop naming it first.
      if (docPageIdToRelease) {
        releaseDocPreviewGrant(docPageIdToRelease)
      }
      const workspaceAfter = findWorkspace(get().browserTabsByWorktree, newPage.workspaceId)
      if (workspaceAfter?.activePageId === newPage.id) {
        const item = Object.values(get().unifiedTabsByWorktree)
          .flat()
          .find(
            (entry) => entry.contentType === 'browser' && entry.entityId === newPage.workspaceId
          )
        if (item) {
          get().setTabLabel(item.id, newPage.title)
        }
      }
      return newPage
    },

    reopenClosedBrowserPage: (workspaceId) => {
      // Why: read and pop atomically inside set() so two rapid Cmd+Shift+T presses can't both restore the same page (TOCTOU).
      let pageToRestore: BrowserPage | undefined

      set((s) => {
        const recentlyClosed = s.recentlyClosedBrowserPagesByWorkspace[workspaceId] ?? []
        pageToRestore = recentlyClosed[0]
        if (!pageToRestore) {
          return s
        }
        return {
          recentlyClosedBrowserPagesByWorkspace: {
            ...s.recentlyClosedBrowserPagesByWorkspace,
            [workspaceId]: recentlyClosed.slice(1)
          }
        }
      })

      if (!pageToRestore) {
        return null
      }

      return get().createBrowserPage(workspaceId, pageToRestore.url, {
        title: pageToRestore.title,
        activate: true,
        browserRuntimeEnvironmentId: pageToRestore.browserRuntimeEnvironmentId,
        ...(pageToRestore.docLocation ? { docLocation: pageToRestore.docLocation } : {})
      })
    },

    setActiveBrowserPage: (workspaceId, pageId) => {
      set((s) => {
        const workspace = findWorkspace(s.browserTabsByWorktree, workspaceId)
        if (!workspace) {
          return s
        }
        const pages = s.browserPagesByWorkspace[workspaceId] ?? []
        if (!pages.some((page) => page.id === pageId)) {
          return s
        }
        const nextWorkspace = mirrorWorkspaceFromActivePage(
          {
            ...workspace,
            activePageId: pageId
          },
          pages
        )
        return {
          browserTabsByWorktree: {
            ...s.browserTabsByWorktree,
            [workspace.worktreeId]: (s.browserTabsByWorktree[workspace.worktreeId] ?? []).map(
              (tab) => (tab.id === workspaceId ? nextWorkspace : tab)
            )
          }
        }
      })

      // Why: switching the active page changes which guest webContents the CDP bridge targets for agent commands.
      const activePage = (get().browserPagesByWorkspace[workspaceId] ?? []).find(
        (page) => page.id === pageId
      )
      const workspace = findWorkspace(get().browserTabsByWorktree, workspaceId)
      if (
        workspace &&
        isLocalBrowserPageOwner(
          get(),
          workspace.worktreeId,
          activePage?.browserRuntimeEnvironmentId
        ) &&
        typeof window !== 'undefined' &&
        window.api?.browser
      ) {
        window.api.browser.notifyActiveTabChanged({ browserPageId: pageId }).catch(() => {})
      }
      if (!workspace) {
        return
      }
      const item = Object.values(get().unifiedTabsByWorktree)
        .flat()
        .find((entry) => entry.contentType === 'browser' && entry.entityId === workspaceId)
      if (item) {
        get().setTabLabel(item.id, workspace.title)
      }
    }
  }
}
