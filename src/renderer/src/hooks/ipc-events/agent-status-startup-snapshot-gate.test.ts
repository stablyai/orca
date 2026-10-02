import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_STATUS_STARTUP_SNAPSHOT_WAIT_MS,
  armAgentStatusStartupSnapshot,
  holdAgentStatusStartupSnapshotForReplay,
  releaseAgentStatusStartupSnapshotReplayHold,
  resetAgentStatusStartupSnapshotGate,
  settleAgentStatusStartupSnapshot,
  waitForAgentStatusStartupSnapshot
} from './agent-status-startup-snapshot-gate'

afterEach(() => {
  resetAgentStatusStartupSnapshotGate()
  vi.useRealTimers()
})

describe('agent status startup snapshot gate', () => {
  it('resolves immediately when no snapshot is in flight', async () => {
    await expect(waitForAgentStatusStartupSnapshot()).resolves.toBeUndefined()
  })

  it('stays pending until the armed snapshot settles', async () => {
    const epoch = armAgentStatusStartupSnapshot()
    let settled = false
    const waiting = waitForAgentStatusStartupSnapshot().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    settleAgentStatusStartupSnapshot(epoch)
    await waiting
    expect(settled).toBe(true)
  })

  it('ignores a stale settle after a newer snapshot is armed', async () => {
    const first = armAgentStatusStartupSnapshot()
    settleAgentStatusStartupSnapshot(first)
    const second = armAgentStatusStartupSnapshot()
    let settled = false
    const waiting = waitForAgentStatusStartupSnapshot().then(() => {
      settled = true
    })
    settleAgentStatusStartupSnapshot(first)
    await Promise.resolve()
    expect(settled).toBe(false)

    settleAgentStatusStartupSnapshot(second)
    await waiting
    expect(settled).toBe(true)
  })

  it('releases a pane that is not in the remaining replay hold', async () => {
    const epoch = armAgentStatusStartupSnapshot()
    const owner = {}
    let ready = false
    let blocked = false
    const readyWait = waitForAgentStatusStartupSnapshot(undefined, 'ready-pane').then(() => {
      ready = true
    })
    const blockedWait = waitForAgentStatusStartupSnapshot(undefined, 'blocked-pane').then(() => {
      blocked = true
    })

    holdAgentStatusStartupSnapshotForReplay(epoch, owner, ['blocked-pane'])
    await readyWait
    expect(ready).toBe(true)
    await Promise.resolve()
    expect(blocked).toBe(false)

    expect(releaseAgentStatusStartupSnapshotReplayHold(true, owner, [])).toBe(true)
    await blockedWait
    expect(blocked).toBe(true)
  })

  it('does not let a different queue release a replay hold', async () => {
    const epoch = armAgentStatusStartupSnapshot()
    const owner = {}
    holdAgentStatusStartupSnapshotForReplay(epoch, owner)
    let settled = false
    const waiting = waitForAgentStatusStartupSnapshot().then(() => {
      settled = true
    })

    expect(releaseAgentStatusStartupSnapshotReplayHold(false, {})).toBe(false)
    await Promise.resolve()
    expect(settled).toBe(false)

    expect(releaseAgentStatusStartupSnapshotReplayHold(false, owner)).toBe(true)
    await waiting
    expect(settled).toBe(true)
  })

  it('releases a waiter when the ready window resets', async () => {
    armAgentStatusStartupSnapshot()
    let settled = false
    const waiting = waitForAgentStatusStartupSnapshot().then(() => {
      settled = true
    })
    resetAgentStatusStartupSnapshotGate()
    await waiting
    expect(settled).toBe(true)
    await expect(waitForAgentStatusStartupSnapshot()).resolves.toBeUndefined()
  })

  it('stops waiting at the bound when the snapshot never arrives', async () => {
    vi.useFakeTimers()
    armAgentStatusStartupSnapshot()
    let settled = false
    const waiting = waitForAgentStatusStartupSnapshot().then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(AGENT_STATUS_STARTUP_SNAPSHOT_WAIT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await waiting
    expect(settled).toBe(true)
  })
})
