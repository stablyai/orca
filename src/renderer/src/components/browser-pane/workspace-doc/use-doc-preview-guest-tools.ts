import type { MutableRefObject } from 'react'
import { useBrowserGuestElementTools } from '@/components/browser-pane/annotate/use-browser-guest-element-tools'

/**
 * The preview's half of the browser tool cluster, wired exactly as the browsing pane wires it —
 * including the id, which is the browser page for both the stored annotations and the tool target.
 * A re-mint replaces the guest under that page rather than renaming the surface, so nothing here
 * has to track which grant is currently on screen.
 */
export function useDocPreviewGuestTools({
  previewId,
  worktreeId,
  grantId,
  webviewRef,
  containerRef,
  toolsReady
}: {
  previewId: string
  worktreeId: string
  grantId: string | null
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  containerRef: MutableRefObject<HTMLDivElement | null>
  toolsReady: boolean
}): ReturnType<typeof useBrowserGuestElementTools> {
  return useBrowserGuestElementTools({
    browserPageId: previewId,
    // Why still empty before the first grant: the page is only a tool target once a document is on
    // screen, and useGrabMode needs a stable identity every render rather than one to guess with.
    toolTargetId: grantId === null ? '' : previewId,
    worktreeId,
    webviewRef,
    containerRef,
    toolsReady
  })
}
