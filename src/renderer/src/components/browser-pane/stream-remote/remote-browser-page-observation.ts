import type {
  BrowserPage,
  BrowserCertificateFailure
} from '../../../../../shared/browser-workspace-types'
import { readBrowserPageLoadingOwner } from '@/lib/browser/browser-page-loading-ownership'

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
  const page = readRemoteBrowserPage(state, workspaceId, pageId)
  return [page, state.browserCertificateFailuresByPageId[pageId], readBrowserPageLoadingOwner(page)]
}
