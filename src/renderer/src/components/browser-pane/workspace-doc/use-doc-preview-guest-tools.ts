import type { MutableRefObject } from 'react'
import { useBrowserGuestElementTools } from '@/components/browser-pane/annotate/use-browser-guest-element-tools'

/** Use the stable browser page ID for annotations and tools so replacing the guest grant preserves both. */
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
    // No tool target exists before the first grant commits; do not queue requests for a page without a document.
    toolTargetId: grantId === null ? '' : previewId,
    worktreeId,
    webviewRef,
    containerRef,
    toolsReady
  })
}
