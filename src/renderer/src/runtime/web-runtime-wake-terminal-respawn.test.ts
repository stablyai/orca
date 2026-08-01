import { beforeEach, describe, expect, it } from 'vitest'
import {
  beginWebRuntimeWakeTerminalRespawn,
  clearWebRuntimeWakeTerminalRespawnForEnvironment,
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
    expect(beginWebRuntimeWakeTerminalRespawn('env-1', 'wt-1')).toBe(true)
    expect(shouldSkipWebRuntimeWakeTerminalRespawn('env-1', 'wt-1')).toBe(true)
    expect(beginWebRuntimeWakeTerminalRespawn('env-1', 'wt-1')).toBe(false)
    endWebRuntimeWakeTerminalRespawn('env-1', 'wt-1')
    expect(shouldSkipWebRuntimeWakeTerminalRespawn('env-1', 'wt-1')).toBe(false)
    expect(beginWebRuntimeWakeTerminalRespawn('env-1', 'wt-1')).toBe(true)
  })

  it('clears wake respawn tracking for a removed worktree', () => {
    beginWebRuntimeWakeTerminalRespawn('env-1', 'wt-1')
    clearWebRuntimeWakeTerminalRespawnForWorktree('env-1', 'wt-1')
    expect(shouldSkipWebRuntimeWakeTerminalRespawn('env-1', 'wt-1')).toBe(false)
    expect(beginWebRuntimeWakeTerminalRespawn('env-1', 'wt-1')).toBe(true)
  })

  it("scopes an environment clear to that environment's in-flight guards", () => {
    // Regression: env A's recycle wiped every environment's guards, letting a
    // concurrent env B respawn duplicate its terminal.
    beginWebRuntimeWakeTerminalRespawn('env-a', 'wt-1')
    beginWebRuntimeWakeTerminalRespawn('env-b', 'wt-1')
    clearWebRuntimeWakeTerminalRespawnForEnvironment('env-a')
    expect(shouldSkipWebRuntimeWakeTerminalRespawn('env-a', 'wt-1')).toBe(false)
    expect(shouldSkipWebRuntimeWakeTerminalRespawn('env-b', 'wt-1')).toBe(true)
    expect(beginWebRuntimeWakeTerminalRespawn('env-b', 'wt-1')).toBe(false)
  })
})
