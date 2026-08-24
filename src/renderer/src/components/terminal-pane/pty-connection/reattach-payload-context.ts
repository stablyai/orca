import type { PtyBufferSnapshot, PtyConnectResult } from '../pty-transport'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'

// Per-call locals for applyReattachPayload so overlapping reattaches stay isolated.
export type ReattachPayloadContext = {
  isCurrentReattachPayload: () => boolean
  connectResult: PtyConnectResult | null
  ptyId: string
  attemptGeneration: number
  prefetchedParkModelSnapshot: PtyBufferSnapshot | null
  revealFollowsTerminalPark: boolean
  fetchSshMainModelReattachSnapshot: () => Promise<PtyBufferSnapshot | null>
  hasStructuralReplay: boolean
  coldRestoreStartup: ColdRestoreAgentResumeStartup | null | undefined
  reattachPayloadApplied: boolean
}
