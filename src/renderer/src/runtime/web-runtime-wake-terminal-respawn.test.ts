import { beforeEach, describe, expect, it } from 'vitest'
import {
  beginWebRuntimeWakeTerminalRespawn,
  clearWebRuntimeWakeTerminalRespawnForWorktree,
  endWebRuntimeWakeTerminalRespawn,
  resetWebRuntimeWakeTerminalRespawnForTests,
  shouldSkipWebRuntimeWakeTerminalRespawn
} from './web-runtime-wake-terminal-respawn'

const ENV = 'env-a'

describe('web-runtime-wake-terminal-respawn', () => {
  beforeEach(() => {
    resetWebRuntimeWakeTerminalRespawnForTests()
  })

  it('dedupes concurrent wake respawn requests for the same worktree', () => {
    expect(beginWebRuntimeWakeTerminalRespawn(ENV, 'wt-1')).toBe(true)
    expect(shouldSkipWebRuntimeWakeTerminalRespawn(ENV, 'wt-1')).toBe(true)
    expect(beginWebRuntimeWakeTerminalRespawn(ENV, 'wt-1')).toBe(false)
    endWebRuntimeWakeTerminalRespawn(ENV, 'wt-1')
    expect(shouldSkipWebRuntimeWakeTerminalRespawn(ENV, 'wt-1')).toBe(false)
    expect(beginWebRuntimeWakeTerminalRespawn(ENV, 'wt-1')).toBe(true)
  })

  it('clears wake respawn tracking for a removed worktree', () => {
    beginWebRuntimeWakeTerminalRespawn(ENV, 'wt-1')
    clearWebRuntimeWakeTerminalRespawnForWorktree(ENV, 'wt-1')
    expect(shouldSkipWebRuntimeWakeTerminalRespawn(ENV, 'wt-1')).toBe(false)
    expect(beginWebRuntimeWakeTerminalRespawn(ENV, 'wt-1')).toBe(true)
  })
})
