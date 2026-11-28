import type { FitHoldMode } from '@/lib/pane-manager/terminal-fit/mobile-fit-overrides'
import { claimsRemoteDesktopViewportOnInput } from '@/components/terminal-pane/viewport/remote-desktop-viewport-claim'
import type { RemoteRuntimeMultiplexedTerminal } from '@/runtime/hosted-terminals/streams/remote-terminal-stream-contracts'

/** A preview's grid as a paired pane holds it: who holds it, as the host last said, and the grid
 *  this preview last claimed. */
export type PreviewViewportHold = {
  mode: FitHoldMode | undefined
  claimed: { cols: number; rows: number } | null
}

type HeldStream = {
  stream: Pick<RemoteRuntimeMultiplexedTerminal, 'claimViewport' | 'sendInput'> | null
  hold: PreviewViewportHold
}

export function claimPreviewViewport(
  session: HeldStream | undefined,
  cols: number,
  rows: number
): boolean {
  const claimed = session?.stream?.claimViewport(cols, rows) ?? false
  if (session && claimed) {
    session.hold.claimed = { cols, rows }
  }
  return claimed
}

/** Sends typing, first taking back the grid a peer (the host, another viewer) took, as a paired pane does. */
export function sendPreviewInput(session: HeldStream | undefined, data: string): boolean {
  const claimed = session?.hold.claimed
  if (claimed && claimsRemoteDesktopViewportOnInput(session.hold.mode, data)) {
    session.stream?.claimViewport(claimed.cols, claimed.rows)
  }
  return session?.stream?.sendInput(data) ?? false
}
