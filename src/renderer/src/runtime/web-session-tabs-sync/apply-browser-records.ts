import type { applyTerminalRecordUpdates } from './apply-terminal-records'
import {
  browserCertificateFailureEqual,
  optionalRuntimeBrowserPlacementsEqual,
  sameBrowserPages
} from './state-equality-tabs'
import { setWebSessionTabsRecordEntry } from './state-equality-core'
import { markWebSessionBrowserPlacementAdopted } from '../web-session-browser-placement'

type BrowserRecordContext = ReturnType<typeof applyTerminalRecordUpdates>

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
        nextBrowserPagesByWorkspace = setWebSessionTabsRecordEntry(
          state,
          'browserPagesByWorkspace',
          removedWorkspaceId,
          undefined,
          batchContext,
          true,
          nextBrowserPagesByWorkspace
        )
      }
      for (const page of pages) {
        if (nextBrowserPageIds.has(page.id)) {
          continue
        }
        if (nextBrowserCertificateFailuresByPageId[page.id]) {
          nextBrowserCertificateFailuresByPageId = setWebSessionTabsRecordEntry(
            state,
            'browserCertificateFailuresByPageId',
            page.id,
            undefined,
            batchContext,
            true,
            nextBrowserCertificateFailuresByPageId
          )
        }
        if (nextRemoteBrowserPageHandlesByPageId[page.id]) {
          nextRemoteBrowserPageHandlesByPageId = setWebSessionTabsRecordEntry(
            state,
            'remoteBrowserPageHandlesByPageId',
            page.id,
            undefined,
            batchContext,
            true,
            nextRemoteBrowserPageHandlesByPageId
          )
        }
      }
    }
  }

  for (const {
    page,
    certificateFailure,
    remotePageId,
    browserProfileId,
    placement
  } of mirroredBrowserTabs) {
    const current = nextBrowserPagesByWorkspace[page.workspaceId] ?? []
    if (!sameBrowserPages(current, [page])) {
      nextBrowserPagesByWorkspace = setWebSessionTabsRecordEntry(
        state,
        'browserPagesByWorkspace',
        page.workspaceId,
        [page],
        batchContext,
        false,
        nextBrowserPagesByWorkspace
      )
    }
    const currentHandle = nextRemoteBrowserPageHandlesByPageId[page.id]
    if (
      currentHandle?.environmentId !== environmentId ||
      currentHandle.remotePageId !== remotePageId ||
      currentHandle.browserProfileId !== browserProfileId ||
      // A host snapshot is the adoption boundary for a staged handle.
      currentHandle.staged === true ||
      // Restored markers are spent when the host republishes the page.
      currentHandle.restoredFromSession === true ||
      !optionalRuntimeBrowserPlacementsEqual(currentHandle.placement, placement)
    ) {
      nextRemoteBrowserPageHandlesByPageId = setWebSessionTabsRecordEntry(
        state,
        'remoteBrowserPageHandlesByPageId',
        page.id,
        {
          environmentId,
          remotePageId,
          ...(browserProfileId ? { browserProfileId } : {}),
          ...(placement ? { placement } : {})
        },
        batchContext,
        false,
        nextRemoteBrowserPageHandlesByPageId
      )
    }
    markWebSessionBrowserPlacementAdopted({ environmentId, worktreeId, remotePageId })
    if (
      placement?.kind !== 'client' &&
      !browserCertificateFailureEqual(
        nextBrowserCertificateFailuresByPageId[page.id],
        certificateFailure
      )
    ) {
      nextBrowserCertificateFailuresByPageId = setWebSessionTabsRecordEntry(
        state,
        'browserCertificateFailuresByPageId',
        page.id,
        certificateFailure ?? undefined,
        batchContext,
        !certificateFailure,
        nextBrowserCertificateFailuresByPageId
      )
    }
  }

  return {
    ...context,
    nextBrowserPagesByWorkspace,
    nextRemoteBrowserPageHandlesByPageId,
    nextBrowserCertificateFailuresByPageId
  }
}
