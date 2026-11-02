/** Unknown capabilities retain panes during outages but must be re-asked after recovery to release eviction exemptions. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PTY_SESSION_ID_SEPARATOR } from '../../../../shared/pty-session-id-format'
import { isEvictionExemptTerminalPty } from '../terminal-pane/terminal-hidden-worktree-retention'
import {
  clearTerminalProviderSnapshotCapabilities,
  synchronizeTerminalProviderSnapshotCapabilities,
  terminalProviderHasAuthoritativeSnapshot
} from './terminal-provider-snapshot-capability'

const WORKTREE_ID = 'wt-resettlement'
const PTY_ID = `${WORKTREE_ID}${PTY_SESSION_ID_SEPARATOR}session-1`

async function exhaustRetryBudget(
  resolver: (ids: string[]) => Promise<{ id: string; authoritative: boolean | null }[]>,
  startMs: number
): Promise<number> {
  const livePtyIds = [PTY_ID]
  let nowMs = startMs
  // 8 attempts across the 1/2/4/8/16/30/30s ladder, plus slack iterations.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const retryDelayMs = await synchronizeTerminalProviderSnapshotCapabilities(
      livePtyIds,
      resolver,
      nowMs
    )
    if (retryDelayMs === null) {
      break
    }
    nowMs += retryDelayMs + 1
  }
  return nowMs
}

describe('terminal provider snapshot capability re-settlement', () => {
  beforeEach(() => clearTerminalProviderSnapshotCapabilities())

  it('keeps an unknown-capability pty exempt during the outage (safety)', async () => {
    const failingResolver = vi.fn(async () => {
      throw new Error('daemon unavailable')
    })
    await synchronizeTerminalProviderSnapshotCapabilities([PTY_ID], failingResolver, 1_000)

    expect(failingResolver).toHaveBeenCalled()
    expect(terminalProviderHasAuthoritativeSnapshot(PTY_ID)).toBe(false)
    expect(isEvictionExemptTerminalPty(PTY_ID, WORKTREE_ID)).toBe(true)
  })

  it('re-consults a recovered resolver after the retry budget and clears the exemption', async () => {
    const failingResolver = vi.fn(async () => {
      throw new Error('daemon unavailable')
    })
    const settledAtMs = await exhaustRetryBudget(failingResolver, 1_000)
    expect(isEvictionExemptTerminalPty(PTY_ID, WORKTREE_ID)).toBe(true)

    const healthyResolver = vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, authoritative: true }))
    )
    // Allow slow re-ask after recovery; a fresh PTY set also models ordinary tab churn.
    const recoveredAtMs = settledAtMs + 10 * 60_000
    await synchronizeTerminalProviderSnapshotCapabilities([PTY_ID], healthyResolver, recoveredAtMs)
    const secondPassMs = recoveredAtMs + 10 * 60_000
    await synchronizeTerminalProviderSnapshotCapabilities([PTY_ID], healthyResolver, secondPassMs)

    expect(healthyResolver).toHaveBeenCalled()
    expect(terminalProviderHasAuthoritativeSnapshot(PTY_ID)).toBe(true)
    expect(isEvictionExemptTerminalPty(PTY_ID, WORKTREE_ID)).toBe(false)
  })
})
