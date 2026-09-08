import { beforeEach, describe, expect, it } from 'vitest'
import {
  beginWebRuntimeWakeTerminalRespawn,
  clearAllWebRuntimeWakeTerminalRespawn,
  clearWebRuntimeWakeTerminalRespawnForWorktree,
  endWebRuntimeWakeTerminalRespawn,
  resetWebRuntimeWakeTerminalRespawnForTests
} from './web-runtime-wake-terminal-respawn'

describe('web-runtime-wake-terminal-respawn', () => {
  beforeEach(() => {
    resetWebRuntimeWakeTerminalRespawnForTests()
  })

  it('dedupes concurrent wake respawn requests for the same worktree', () => {
    expect(beginWebRuntimeWakeTerminalRespawn('wt-1')).toBe(true)
    expect(beginWebRuntimeWakeTerminalRespawn('wt-1')).toBe(false)
    endWebRuntimeWakeTerminalRespawn('wt-1')
    expect(beginWebRuntimeWakeTerminalRespawn('wt-1')).toBe(true)
  })

  it('clears wake respawn tracking for a removed worktree', () => {
    expect(beginWebRuntimeWakeTerminalRespawn('wt-1')).toBe(true)
    expect(beginWebRuntimeWakeTerminalRespawn('wt-2')).toBe(true)
    clearWebRuntimeWakeTerminalRespawnForWorktree('wt-1')
    expect(beginWebRuntimeWakeTerminalRespawn('wt-1')).toBe(true)
    expect(beginWebRuntimeWakeTerminalRespawn('wt-2')).toBe(false)
  })

  it('clears all in-flight worktrees when tracking stops', () => {
    expect(beginWebRuntimeWakeTerminalRespawn('wt-1')).toBe(true)
    expect(beginWebRuntimeWakeTerminalRespawn('wt-2')).toBe(true)
    clearAllWebRuntimeWakeTerminalRespawn()
    expect(beginWebRuntimeWakeTerminalRespawn('wt-1')).toBe(true)
    expect(beginWebRuntimeWakeTerminalRespawn('wt-2')).toBe(true)
  })
})
