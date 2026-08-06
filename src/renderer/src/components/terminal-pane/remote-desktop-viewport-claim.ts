import type { FitHoldMode } from '@/lib/pane-manager/mobile-fit-overrides'

type TerminalGrid = { cols: number; rows: number }

export function shouldClaimRemoteDesktopViewport(args: {
  holdMode: FitHoldMode
  prior: TerminalGrid | null
  current: TerminalGrid
  paneGeometryChanged: boolean
  paneVisible: boolean
  documentVisible: boolean
  documentFocused: boolean
}): boolean {
  return Boolean(
    args.holdMode === 'remote-desktop-fit' &&
    (args.paneGeometryChanged ||
      (args.prior &&
        (args.prior.cols !== args.current.cols || args.prior.rows !== args.current.rows))) &&
    args.paneVisible &&
    args.documentVisible &&
    args.documentFocused
  )
}
