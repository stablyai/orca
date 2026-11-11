import type {
  BrowserPage,
  BrowserCertificateFailure
} from '../../../../../shared/browser-workspace-types'

type BrowserObservationState = {
  browserPagesByWorkspace: Record<string, BrowserPage[]>
  browserCertificateFailuresByPageId: Record<string, BrowserCertificateFailure>
}

export function createRemoteBrowserPageObservation({
  readState,
  getWorkspaceId,
  getPageId
}: {
  readState: () => BrowserObservationState
  getWorkspaceId: () => string
  getPageId: () => string
}) {
  const readPage = (pageId: string): BrowserPage | undefined =>
    readState().browserPagesByWorkspace[getWorkspaceId()]?.find((page) => page.id === pageId)
  return {
    browserPageExists: (pageId: string): boolean => Boolean(readPage(pageId)),
    readCurrentObservation: (): readonly unknown[] => [
      readPage(getPageId()),
      readState().browserCertificateFailuresByPageId[getPageId()]
    ]
  }
}
