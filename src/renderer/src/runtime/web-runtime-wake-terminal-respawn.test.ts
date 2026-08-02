import { beforeEach, describe, expect, it } from 'vitest'
import {
  beginWebRuntimeWakeTerminalRespawn,
  clearWebRuntimeWakeTerminalRespawnForWorktree,
  endWebRuntimeWakeTerminalRespawn,
  resetWebRuntimeWakeTerminalRespawnForTests,
  shouldSkipWebRuntimeWakeTerminalRespawn
} from './web-runtime-wake-terminal-respawn'

describe('web-runtime-wake-terminal-respawn', () => {
  beforeEach(() => {
    resetWebRuntimeWakeTerminalRespawnForTests()
  })

  it('dedupes concurrent wake respawn requests for the same worktree', () => {
    expect(beginWebRuntimeWakeTerminalRespawn('wt-1')).toBe(true)
    expect(shouldSkipWebRuntimeWakeTerminalRespawn('wt-1')).toBe(true)
    expect(beginWebRuntimeWakeTerminalRespawn('wt-1')).toBe(false)
    endWebRuntimeWakeTerminalRespawn('wt-1')
    expect(shouldSkipWebRuntimeWakeTerminalRespawn('wt-1')).toBe(false)
    expect(beginWebRuntimeWakeTerminalRespawn('wt-1')).toBe(true)
  })

  it('clears wake respawn tracking for a removed worktree', () => {
    beginWebRuntimeWakeTerminalRespawn('wt-1')
    clearWebRuntimeWakeTerminalRespawnForWorktree('wt-1')
    expect(shouldSkipWebRuntimeWakeTerminalRespawn('wt-1')).toBe(false)
    expect(beginWebRuntimeWakeTerminalRespawn('wt-1')).toBe(true)
  })
})
