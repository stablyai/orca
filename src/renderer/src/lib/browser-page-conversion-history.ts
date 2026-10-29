import type { BrowserPageConversionOrigin } from '../../../shared/browser-workspace-types'
import type { BrowserPageConversionLeg } from '@/store/slices/browser-page-conversion'
import { convertBrowserPageToWorkspaceDoc } from '@/lib/file-preview'
import { useAppStore } from '@/store'

function crossBrowserPageConversion(
  pageId: string,
  origin: BrowserPageConversionOrigin,
  leg: BrowserPageConversionLeg
): void {
  if (origin.kind === 'workspace-doc') {
    convertBrowserPageToWorkspaceDoc(pageId, origin.docLocation, { leg })
    return
  }
  useAppStore.getState().convertBrowserPage(
    pageId,
    {
      kind: 'web',
      url: origin.url,
      // Keep undefined ownership present: it means worktree-inferred, and client-local fallback would move browsing onto this desktop.
      browserRuntimeEnvironmentId: origin.browserRuntimeEnvironmentId
    },
    { leg }
  )
}

/** With guest history exhausted, Back consumes convertedFrom and saves convertedTo so Forward can re-cross the conversion. */
export function returnAcrossBrowserPageConversion(
  pageId: string,
  origin: BrowserPageConversionOrigin
): void {
  crossBrowserPageConversion(pageId, origin, 'history-return')
}

/** Forward consumes convertedTo and restores convertedFrom so Back can cross again. */
export function advanceAcrossBrowserPageConversion(
  pageId: string,
  origin: BrowserPageConversionOrigin
): void {
  crossBrowserPageConversion(pageId, origin, 'history-advance')
}
