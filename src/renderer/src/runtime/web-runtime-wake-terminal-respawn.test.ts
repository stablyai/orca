import { beforeEach, describe, expect, it } from 'vitest'
import {
  beginWebRuntimeWakeTerminalRespawn,
  endWebRuntimeWakeTerminalRespawn,
  resetWebRuntimeWakeTerminalRespawnForTests,
  shouldSkipWebRuntimeWakeTerminalRespawn
} from './web-runtime-wake-terminal-respawn'

describe('web-runtime-wake-terminal-respawn', () => {
  beforeEach(() => {
    resetWebRuntimeWakeTerminalRespawnForTests()
  })

  it('dedupes wake respawn requests for the same worktree', () => {
    expect(beginWebRuntimeWakeTerminalRespawn('wt-1')).toBe(true)
    expect(shouldSkipWebRuntimeWakeTerminalRespawn('wt-1')).toBe(true)
    expect(beginWebRuntimeWakeTerminalRespawn('wt-1')).toBe(false)
    endWebRuntimeWakeTerminalRespawn('wt-1')
    expect(shouldSkipWebRuntimeWakeTerminalRespawn('wt-1')).toBe(true)
  })
})
