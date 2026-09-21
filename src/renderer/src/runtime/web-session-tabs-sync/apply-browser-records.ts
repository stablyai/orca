import type { applyTerminalRecordUpdates } from './apply-terminal-records'
import {
  browserCertificateFailureEqual,
  optionalRuntimeBrowserPlacementsEqual,
  sameBrowserPages
} from './state-equality-tabs'
import { writableWebSessionTabsRecord } from './state-equality-core'
import { markWebSessionBrowserPlacementAdopted } from '../web-session-browser-placement'

type BrowserRecordContext = ReturnType<typeof applyTerminalRecordUpdates>

/** Reconcile browser page records, remote handles, and certificate failures. */
export function applyBrowserRecordUpdates(context: BrowserRecordContext) {
  const {
    state,
    batchContext,
    environmentId,
    worktreeId,
    mirroredBrowserTabs,
    removedBrowserWorkspaceIds,
    retainedBrowserTabs,
    nextBrowserTabs
  } = context

  let nextBrowserPagesByWorkspace = state.browserPagesByWorkspace
  let nextRemoteBrowserPageHandlesByPageId = state.remoteBrowserPageHandlesByPageId
  let nextBrowserCertificateFailuresByPageId = state.browserCertificateFailuresByPageId

  if (removedBrowserWorkspaceIds.size > 0) {
    const nextBrowserWorkspaceIds = new Set(nextBrowserTabs?.map((tab) => tab.id) ?? [])
    const nextBrowserPageIds = new Set(mirroredBrowserTabs.map((entry) => entry.page.id))
    for (const workspace of retainedBrowserTabs) {
      for (const page of state.browserPagesByWorkspace[workspace.id] ?? []) {
        nextBrowserPageIds.add(page.id)
      }
    }
    for (const removedWorkspaceId of removedBrowserWorkspaceIds) {
      const pages = nextBrowserPagesByWorkspace[removedWorkspaceId] ?? []
      if (
        !nextBrowserWorkspaceIds.has(removedWorkspaceId) &&
        nextBrowserPagesByWorkspace[removedWorkspaceId]
      ) {
        nextBrowserPagesByWorkspace =
          nextBrowserPagesByWorkspace === state.browserPagesByWorkspace
            ? writableWebSessionTabsRecord(state, 'browserPagesByWorkspace', batchContext)
            : nextBrowserPagesByWorkspace
        delete nextBrowserPagesByWorkspace[removedWorkspaceId]
      }
      for (const page of pages) {
        if (nextBrowserPageIds.has(page.id)) {
          continue
        }
        if (nextBrowserCertificateFailuresByPageId[page.id]) {
          nextBrowserCertificateFailuresByPageId =
            nextBrowserCertificateFailuresByPageId === state.browserCertificateFailuresByPageId
              ? writableWebSessionTabsRecord(
                  state,
                  'browserCertificateFailuresByPageId',
                  batchContext
                )
              : nextBrowserCertificateFailuresByPageId
          delete nextBrowserCertificateFailuresByPageId[page.id]
        }
        if (nextRemoteBrowserPageHandlesByPageId[page.id]) {
          nextRemoteBrowserPageHandlesByPageId =
            nextRemoteBrowserPageHandlesByPageId === state.remoteBrowserPageHandlesByPageId
              ? writableWebSessionTabsRecord(
                  state,
                  'remoteBrowserPageHandlesByPageId',
                  batchContext
                )
              : nextRemoteBrowserPageHandlesByPageId
          delete nextRemoteBrowserPageHandlesByPageId[page.id]
        }
      }
    }
  }

  for (const { page, certificateFailure, remotePageId, placement } of mirroredBrowserTabs) {
    const current = nextBrowserPagesByWorkspace[page.workspaceId] ?? []
    if (!sameBrowserPages(current, [page])) {
      nextBrowserPagesByWorkspace =
        nextBrowserPagesByWorkspace === state.browserPagesByWorkspace
          ? writableWebSessionTabsRecord(state, 'browserPagesByWorkspace', batchContext)
          : nextBrowserPagesByWorkspace
      nextBrowserPagesByWorkspace[page.workspaceId] = [page]
    }
    const currentHandle = nextRemoteBrowserPageHandlesByPageId[page.id]
    if (
      currentHandle?.environmentId !== environmentId ||
      currentHandle.remotePageId !== remotePageId ||
      // A host snapshot is the adoption boundary for a staged handle.
      currentHandle.staged === true ||
      // Restored markers are spent when the host republishes the page.
      currentHandle.restoredFromSession === true ||
      !optionalRuntimeBrowserPlacementsEqual(currentHandle.placement, placement)
    ) {
      nextRemoteBrowserPageHandlesByPageId =
        nextRemoteBrowserPageHandlesByPageId === state.remoteBrowserPageHandlesByPageId
          ? writableWebSessionTabsRecord(state, 'remoteBrowserPageHandlesByPageId', batchContext)
          : nextRemoteBrowserPageHandlesByPageId
      nextRemoteBrowserPageHandlesByPageId[page.id] = {
        environmentId,
        remotePageId,
        ...(placement ? { placement } : {})
      }
    }
    markWebSessionBrowserPlacementAdopted({ environmentId, worktreeId, remotePageId })
    if (
      placement?.kind !== 'client' &&
      !browserCertificateFailureEqual(
        nextBrowserCertificateFailuresByPageId[page.id],
        certificateFailure
      )
    ) {
      nextBrowserCertificateFailuresByPageId =
        nextBrowserCertificateFailuresByPageId === state.browserCertificateFailuresByPageId
          ? writableWebSessionTabsRecord(state, 'browserCertificateFailuresByPageId', batchContext)
          : nextBrowserCertificateFailuresByPageId
      if (certificateFailure) {
        nextBrowserCertificateFailuresByPageId[page.id] = certificateFailure
      } else {
        delete nextBrowserCertificateFailuresByPageId[page.id]
      }
    }
  }

  return {
    ...context,
    nextBrowserPagesByWorkspace,
    nextRemoteBrowserPageHandlesByPageId,
    nextBrowserCertificateFailuresByPageId
  }
}
