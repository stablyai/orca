import type {
  BrowserPage,
  BrowserCertificateFailure
} from '../../../../../shared/browser-workspace-types'

type BrowserObservationState = {
  browserPagesByWorkspace: Record<string, BrowserPage[]>
  browserCertificateFailuresByPageId: Record<string, BrowserCertificateFailure>
}

export function readRemoteBrowserPage(
  state: BrowserObservationState,
  workspaceId: string,
  pageId: string
): BrowserPage | undefined {
  return state.browserPagesByWorkspace[workspaceId]?.find((page) => page.id === pageId)
}

export function readRemoteBrowserPageObservation(
  state: BrowserObservationState,
  workspaceId: string,
  pageId: string
): readonly unknown[] {
  return [
    readRemoteBrowserPage(state, workspaceId, pageId),
    state.browserCertificateFailuresByPageId[pageId]
  ]
}
