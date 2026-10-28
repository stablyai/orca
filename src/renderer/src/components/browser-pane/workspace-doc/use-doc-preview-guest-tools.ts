import { useBrowserGuestTools } from '../annotate/use-browser-guest-tools'

export function useDocPreviewGuestTools({
  previewId,
  grantId,
  ...options
}: {
  previewId: string
  grantId: string | null
  worktreeId: string
  webviewRef: React.MutableRefObject<Electron.WebviewTag | null>
  containerRef: React.MutableRefObject<HTMLDivElement | null>
  toolsReady: boolean
}): ReturnType<typeof useBrowserGuestTools> {
  return useBrowserGuestTools({ ...options, browserPageId: previewId, guestId: grantId })
}
