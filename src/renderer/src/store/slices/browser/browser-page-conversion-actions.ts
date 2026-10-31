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
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { closeRemoteBrowserPageInOwningEnvironment } from './browser-remote-close'
import { releaseDocPreviewGrant } from '@/lib/doc-preview-grants'
import { isLocalBrowserPageOwner } from './browser-host-state'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { sendBrowserLayoutCommand } from './browser-layout-owner-commands'

export function createBrowserPageConversionActions(
  set: BrowserSliceSet,
  get: BrowserSliceGet
): Pick<BrowserSlice, 'convertBrowserPage' | 'reopenClosedBrowserPage' | 'setActiveBrowserPage'> {
  return {
    convertBrowserPage: (pageId, target, options) => {
      // Resolve ownership once (present undefined means worktree-inferred) and apply create’s hosting assertion so plan and permission agree, including paired web refusals.
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
            ? runtimeEnvironmentIdOrLocalUnlessTwin(get(), oldPageForOwnership.worktreeId)
            : null
      )
      const convertHere = (newPageId?: string): BrowserPage | null => {
        let converted: BrowserPage | null = null
        let docPageIdToRelease: string | null = null
        let remotePageToClose: { worktreeId: string; handle: RemoteBrowserPageHandle } | null = null
        set((s) => {
          const plan = planBrowserPageConversion(s, pageId, target, {
            ...options,
            ...(newPageId ? { newPageId } : {})
          })
          if (!plan) {
            return s
          }
          converted = plan.newPage
          // Collect revocations outside reducers so main executes once even if set retries.
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
          const nextBrowserAnnotationMarkerIdsByPageId = { ...s.browserAnnotationMarkerIdsByPageId }
          delete nextBrowserAnnotationsByPageId[plan.oldPage.id]
          delete nextBrowserAnnotationMarkerIdsByPageId[plan.oldPage.id]
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
            browserAnnotationsByPageId: nextBrowserAnnotationsByPageId,
            browserAnnotationMarkerIdsByPageId: nextBrowserAnnotationMarkerIdsByPageId
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
        // Remove row before revoking its grant; closed docs must lose the preview scheme’s sole read authority.
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
      }
      // Switch point: main puts the new page in the old one's place; the page shows once it did.
      const sentPlan = ORCA_LAYOUT_OWNER_IS_MAIN
        ? planBrowserPageConversion(get(), pageId, target, options)
        : null
      if (
        sentPlan &&
        sendBrowserLayoutCommand(
          get,
          sentPlan.workspace.worktreeId,
          {
            type: 'replaceBrowserPage',
            browserTabId: sentPlan.workspace.id,
            pageId,
            newPageId: sentPlan.newPage.id
          },
          {
            here: () => convertHere(sentPlan.newPage.id),
            shown: () => convertHere(sentPlan.newPage.id)
          }
        )
      ) {
        return sentPlan.newPage
      }
      return convertHere()
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
