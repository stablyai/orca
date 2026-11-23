import { scheduleWebglAtlasRecoveryBurst } from './terminal-webgl-atlas-recovery'

const MISMATCH_BURST_THRESHOLD = 3
const MISMATCH_WINDOW_MS = 2_000
const MISMATCH_BURST_COOLDOWN_MS = 5_000

let mismatchTimestamps: number[] = []
let lastBurstAt = Number.NEGATIVE_INFINITY

/** Bounded WebGL atlas recovery after repeated ctx.font probe failures while rasterizing glyphs (#10133, #5031). */
export function noteAtlasFontProbeMismatch(): void {
  const now = Date.now()
  mismatchTimestamps = mismatchTimestamps.filter((timestamp) => now - timestamp < MISMATCH_WINDOW_MS)
  mismatchTimestamps.push(now)
  if (mismatchTimestamps.length > MISMATCH_BURST_THRESHOLD) {
    mismatchTimestamps.splice(0, mismatchTimestamps.length - MISMATCH_BURST_THRESHOLD)
  }
  if (mismatchTimestamps.length < MISMATCH_BURST_THRESHOLD) {
    return
  }
  if (now - lastBurstAt < MISMATCH_BURST_COOLDOWN_MS) {
    return
  }
  lastBurstAt = now
  mismatchTimestamps = []
  scheduleWebglAtlasRecoveryBurst('atlas-font-probe-mismatch')
}

export function resetAtlasFontProbeRecoveryForTesting(): void {
  mismatchTimestamps = []
  lastBurstAt = Number.NEGATIVE_INFINITY
}