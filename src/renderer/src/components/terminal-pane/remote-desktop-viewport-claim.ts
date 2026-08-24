import type { FitHoldMode } from '@/lib/pane-manager/mobile-fit-overrides'

type TerminalGrid = { cols: number; rows: number }

export function isRemoteDesktopViewportClaimEligible(args: {
  paneVisible: boolean
  documentVisible: boolean
  documentFocused: boolean
}): boolean {
  return args.paneVisible && args.documentVisible && args.documentFocused
}

export function getRemoteDesktopViewportClaimDocumentState(): {
  documentVisible: boolean
  documentFocused: boolean
} {
  const available = typeof document !== 'undefined'
  return {
    documentVisible: available && document.visibilityState !== 'hidden',
    documentFocused: available && typeof document.hasFocus === 'function' && document.hasFocus()
  }
}

export function shouldClaimDesktopViewportForUserActivity(args: {
  initialRemoteFitPending: boolean
  holdMode: FitHoldMode | null
}): boolean {
  return (
    args.holdMode === 'remote-desktop-fit' ||
    (args.initialRemoteFitPending && args.holdMode === null)
  )
}

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
    isRemoteDesktopViewportClaimEligible(args)
  )
}
