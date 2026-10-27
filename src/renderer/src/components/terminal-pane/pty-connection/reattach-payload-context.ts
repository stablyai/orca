import type { PtyBufferSnapshot, PtyConnectResult } from '../pty-transport-types'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'

// Per-call locals for applyReattachPayload so overlapping reattaches stay isolated.
export type ReattachPayloadContext = {
  isCurrentReattachPayload: () => boolean
  connectResult: PtyConnectResult | null
  ptyId: string
  attemptGeneration: number
  prefetchedParkModelSnapshot: PtyBufferSnapshot | null
  revealFollowsTerminalPark: boolean
  shouldApplyStructuralPayload: boolean
  coldRestoreStartup: ColdRestoreAgentResumeStartup | null | undefined
  reattachPayloadApplied: boolean
  /** Capture width of an alt frame the replay omitted as too wide; null when the frame painted. */
  skippedAltFrameCaptureCols: number | null
}
