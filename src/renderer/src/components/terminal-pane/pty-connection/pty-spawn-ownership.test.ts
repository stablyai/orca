import { beforeEach, describe, expect, it } from 'vitest'
import {
  claimPtySpawnRetirement,
  clearPtySpawnRetirementHandoff,
  resetPtySpawnOwnershipForTests,
  revokePtySpawnRetirement,
  successorOwnsPtySpawn
} from './pty-spawn-ownership'

describe('pty spawn retirement ownership', () => {
  beforeEach(() => resetPtySpawnOwnershipForTests())

  it('transfers a watchdog result to the successor by exact PTY identity', () => {
    revokePtySpawnRetirement('tab:leaf')

    claimPtySpawnRetirement('tab:leaf', 'late-live-pty')

    expect(successorOwnsPtySpawn('tab:leaf', 'late-live-pty')).toBe(true)
    expect(successorOwnsPtySpawn('tab:leaf', 'other-pty')).toBe(false)
  })

  it('keeps an unclaimed late result eligible for retirement', () => {
    revokePtySpawnRetirement('tab:leaf')

    expect(successorOwnsPtySpawn('tab:leaf', 'late-unowned-pty')).toBe(false)
  })

  it('can retire the handoff after the predecessor observes the claim', () => {
    revokePtySpawnRetirement('tab:leaf')
    claimPtySpawnRetirement('tab:leaf', 'late-live-pty')
    clearPtySpawnRetirementHandoff('tab:leaf')

    expect(successorOwnsPtySpawn('tab:leaf', 'late-live-pty')).toBe(false)
  })
})
