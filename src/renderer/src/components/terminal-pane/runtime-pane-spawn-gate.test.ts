import { describe, expect, it } from 'vitest'
import {
  RUNTIME_SNAPSHOT_SPAWN_WAIT_MS,
  shouldDeferRuntimePaneSpawn
} from './runtime-pane-spawn-gate'

const ENV = 'runtime:env-1'

describe('shouldDeferRuntimePaneSpawn', () => {
  it('never gates a local or SSH pane', () => {
    const decision = shouldDeferRuntimePaneSpawn({
      runtimeEnvironmentId: null,
      hasPtyBinding: false,
      snapshotAccepted: false,
      hasRestoredPtyHandle: false,
      waitStartedAt: null,
      now: 1_000
    })
    expect(decision.defer).toBe(false)
  })

  it('never gates a pane that already has a PTY binding (the reattach path)', () => {
    const decision = shouldDeferRuntimePaneSpawn({
      runtimeEnvironmentId: ENV,
      hasPtyBinding: true,
      snapshotAccepted: false,
      hasRestoredPtyHandle: false,
      waitStartedAt: null,
      now: 1_000
    })
    expect(decision.defer).toBe(false)
  })

  it('defers a PTY-less runtime pane until the first snapshot is accepted (#15622)', () => {
    const started = shouldDeferRuntimePaneSpawn({
      runtimeEnvironmentId: ENV,
      hasPtyBinding: false,
      snapshotAccepted: false,
      hasRestoredPtyHandle: false,
      waitStartedAt: null,
      now: 1_000
    })
    expect(started).toEqual({ defer: true, waitStartedAt: 1_000 })

    const stillWaiting = shouldDeferRuntimePaneSpawn({
      runtimeEnvironmentId: ENV,
      hasPtyBinding: false,
      snapshotAccepted: false,
      hasRestoredPtyHandle: false,
      waitStartedAt: started.waitStartedAt,
      now: 1_000 + 500
    })
    expect(stillWaiting.defer).toBe(true)

    const accepted = shouldDeferRuntimePaneSpawn({
      runtimeEnvironmentId: ENV,
      hasPtyBinding: false,
      snapshotAccepted: true,
      hasRestoredPtyHandle: false,
      waitStartedAt: started.waitStartedAt,
      now: 1_000 + 500
    })
    expect(accepted.defer).toBe(false)
  })


  it('never gates a sleep-resume pane carrying a preserved PTY handle', () => {
    const decision = shouldDeferRuntimePaneSpawn({
      runtimeEnvironmentId: ENV,
      hasPtyBinding: false,
      snapshotAccepted: false,
      hasRestoredPtyHandle: true,
      waitStartedAt: null,
      now: 1_000
    })
    expect(decision.defer).toBe(false)
  })

  it('stops deferring after the bounded wait so an unreachable runtime still gets a pane', () => {
    const decision = shouldDeferRuntimePaneSpawn({
      runtimeEnvironmentId: ENV,
      hasPtyBinding: false,
      snapshotAccepted: false,
      hasRestoredPtyHandle: false,
      waitStartedAt: 1_000,
      now: 1_000 + RUNTIME_SNAPSHOT_SPAWN_WAIT_MS + 1
    })
    expect(decision.defer).toBe(false)
  })

  it('a snapshot acquired mid-wait wins even for a pane that gained no binding', () => {
    // The snapshot dropped the stale row's expectation: connecting is now safe
    // because the authoritative list no longer contains a PTY this pane would
    // double-spawn beside.
    const decision = shouldDeferRuntimePaneSpawn({
      runtimeEnvironmentId: ENV,
      hasPtyBinding: false,
      snapshotAccepted: true,
      hasRestoredPtyHandle: false,
      waitStartedAt: 1_000,
      now: 1_000 + 50
    })
    expect(decision.defer).toBe(false)
  })
})
