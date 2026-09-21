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
      // Deliberately present even when undefined: absent-on-origin means worktree-inferred, and
      // returning it as client-local would silently move the tab's browsing onto this desktop.
      browserRuntimeEnvironmentId: origin.browserRuntimeEnvironmentId
    },
    { leg }
  )
}

/**
 * Back's one-level return across an address-bar conversion: with no guest history left to go back
 * through, a page that was converted returns to what it was converted from. Arriving back consumes
 * `convertedFrom` and records `convertedTo` on the restored page, so Forward can re-cross —
 * the pair behaves like two history entries.
 */
export function returnAcrossBrowserPageConversion(
  pageId: string,
  origin: BrowserPageConversionOrigin
): void {
  crossBrowserPageConversion(pageId, origin, 'history-return')
}

/**
 * Forward's re-crossing after Back returned: consumes `convertedTo` and records `convertedFrom`
 * again on the rebuilt page, so Back keeps working on the other side.
 */
export function advanceAcrossBrowserPageConversion(
  pageId: string,
  origin: BrowserPageConversionOrigin
): void {
  crossBrowserPageConversion(pageId, origin, 'history-advance')
}
