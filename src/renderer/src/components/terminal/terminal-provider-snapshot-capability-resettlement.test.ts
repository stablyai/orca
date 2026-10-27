/** Unknown capabilities retain panes during outages but must be re-asked after recovery to release eviction exemptions. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PTY_SESSION_ID_SEPARATOR } from '../../../../shared/pty-session-id-format'
import {
  classifyEvictionExemptTerminalPty,
  countEvictionExemptTabRoutes,
  formatEvictionExemptRouteCounts,
  isEvictionExemptTerminalPty
} from '../terminal-pane/terminal-hidden-worktree-retention'
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

  it('classifies exemption routes in parity with the predicate', async () => {
    const failOpenId = 'no-separator-daemon-fail-open'
    const foreignId = `other-worktree${PTY_SESSION_ID_SEPARATOR}session-9`
    const sshId = 'ssh:host@@pty-1'

    expect(classifyEvictionExemptTerminalPty(failOpenId, WORKTREE_ID)).toBe('fail-open')
    expect(classifyEvictionExemptTerminalPty(foreignId, WORKTREE_ID)).toBe('foreign-worktree')
    expect(classifyEvictionExemptTerminalPty(PTY_ID, WORKTREE_ID)).toBe('capability-unknown')
    expect(classifyEvictionExemptTerminalPty(sshId, WORKTREE_ID)).toBeNull()
    expect(classifyEvictionExemptTerminalPty(null, WORKTREE_ID)).toBeNull()

    const healthyResolver = vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, authoritative: true }))
    )
    await synchronizeTerminalProviderSnapshotCapabilities([PTY_ID], healthyResolver, 1_000)
    expect(classifyEvictionExemptTerminalPty(PTY_ID, WORKTREE_ID)).toBeNull()

    for (const id of [failOpenId, foreignId, sshId, PTY_ID, null]) {
      expect(isEvictionExemptTerminalPty(id, WORKTREE_ID)).toBe(
        classifyEvictionExemptTerminalPty(id, WORKTREE_ID) !== null
      )
    }
  })

  // Force-park breadcrumbs consume these buckets; misclassification misdirects triage.
  it('buckets route counts per classification for the force-park breadcrumb', () => {
    const counts = countEvictionExemptTabRoutes(
      [
        { ptyId: 'no-separator-daemon-fail-open' },
        { ptyId: `other-worktree${PTY_SESSION_ID_SEPARATOR}session-9` },
        { ptyId: PTY_ID },
        { ptyId: null }
      ],
      WORKTREE_ID
    )

    expect(counts).toEqual({
      failOpen: 1,
      foreignWorktree: 1,
      capabilityUnknown: 1,
      splitPane: 1
    })
    expect(formatEvictionExemptRouteCounts(counts)).toBe(
      'routes=fail-open:1,foreign:1,capability:1,split-pane:1'
    )
  })
})
