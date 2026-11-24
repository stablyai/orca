import { annotateBrowserPageHandles } from '@/store/slices/browser/hosts/browser-initialization-presentation-ownership'
import type { applyTerminalRecordUpdates } from './apply-terminal-records'
import {
  preserveBrowserPageLoadingOwner,
  revokeBrowserPageLoadingOwner
} from '@/lib/browser/browser-page-loading-ownership'
import {
  browserCertificateFailureEqual,
  optionalRuntimeBrowserPlacementsEqual,
  sameBrowserPages
} from './state-equality-tabs'
import { writableWebSessionTabsRecord } from './state-equality-core'
import type { WebSessionTabsBatchContext, WebSessionTabsSyncState } from '../state'
import { markWebSessionBrowserPlacementAdopted } from '../../browser/placement/web-session-browser-placement'
import { mirrorBrowserAgentPageActive } from '@/components/browser-pane/agent-cursor/browser-agent-activity-state'

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
  let nextBrowserAudiblePageIds = state.browserAudiblePageIds
  let nextBrowserAudioMutedTabIds = state.browserAudioMutedTabIds

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
        nextBrowserAudioMutedTabIds = withAudioFlag(
          state,
          batchContext,
          'browserAudioMutedTabIds',
          nextBrowserAudioMutedTabIds,
          removedWorkspaceId,
          false
        )
      }
      for (const page of pages) {
        if (nextBrowserPageIds.has(page.id)) {
          continue
        }
        revokeBrowserPageLoadingOwner(page)
        mirrorBrowserAgentPageActive(page.id, false, worktreeId)
        nextBrowserAudiblePageIds = withAudioFlag(
          state,
          batchContext,
          'browserAudiblePageIds',
          nextBrowserAudiblePageIds,
          page.id,
          false
        )
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
          annotateBrowserPageHandles(nextRemoteBrowserPageHandlesByPageId, [page.id])
          delete nextRemoteBrowserPageHandlesByPageId[page.id]
        }
      }
    }
  }

  for (const {
    page,
    previousPage,
    preservesLoading,
    certificateFailure,
    audible,
    audioMuted,
    agentDriving,
    remotePageId,
    browserProfileId,
    placement,
    initializationPresentation
  } of mirroredBrowserTabs) {
    if (previousPage) {
      if (preservesLoading) {
        preserveBrowserPageLoadingOwner(previousPage, page)
      } else {
        revokeBrowserPageLoadingOwner(previousPage)
      }
    }
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
      currentHandle.browserProfileId !== browserProfileId ||
      currentHandle.initializationPresentation !== initializationPresentation ||
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
      annotateBrowserPageHandles(nextRemoteBrowserPageHandlesByPageId, [page.id])
      // Re-placed on the server, it is no longer this desktop's to keep hosting.
      const placedHere =
        currentHandle?.placedHere === true &&
        placement?.kind !== 'server' &&
        currentHandle.environmentId === environmentId &&
        currentHandle.remotePageId === remotePageId
      nextRemoteBrowserPageHandlesByPageId[page.id] = {
        environmentId,
        remotePageId,
        ...(placedHere ? { placedHere: true as const } : {}),
        ...(initializationPresentation ? { initializationPresentation } : {}),
        ...(browserProfileId ? { browserProfileId } : {}),
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
    // A streamed page plays on its host, so the host's row is the only source of its sound state.
    if (placement?.kind !== 'client') {
      nextBrowserAudiblePageIds = withAudioFlag(
        state,
        batchContext,
        'browserAudiblePageIds',
        nextBrowserAudiblePageIds,
        page.id,
        audible
      )
      nextBrowserAudioMutedTabIds = withAudioFlag(
        state,
        batchContext,
        'browserAudioMutedTabIds',
        nextBrowserAudioMutedTabIds,
        page.workspaceId,
        audioMuted
      )
      // Agents drive it on its host, whose row is the only source of the tab's agent mark.
      mirrorBrowserAgentPageActive(page.id, agentDriving, worktreeId)
    }
  }

  return {
    ...context,
    nextBrowserPagesByWorkspace,
    nextRemoteBrowserPageHandlesByPageId,
    nextBrowserCertificateFailuresByPageId,
    nextBrowserAudiblePageIds,
    nextBrowserAudioMutedTabIds
  }
}

function withAudioFlag(
  state: WebSessionTabsSyncState,
  batchContext: WebSessionTabsBatchContext | undefined,
  recordKey: 'browserAudiblePageIds' | 'browserAudioMutedTabIds',
  record: Record<string, true>,
  id: string,
  on: boolean
): Record<string, true> {
  if (Boolean(record[id]) === on) {
    return record
  }
  const next =
    record === state[recordKey]
      ? writableWebSessionTabsRecord(state, recordKey, batchContext)
      : record
  if (on) {
    next[id] = true
  } else {
    delete next[id]
  }
  return next
}
