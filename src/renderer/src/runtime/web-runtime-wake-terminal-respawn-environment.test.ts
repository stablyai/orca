import { beforeEach, describe, expect, it } from 'vitest'
import {
  beginWebRuntimeWakeTerminalRespawn,
  clearWebRuntimeWakeTerminalRespawnForEnvironment,
  endWebRuntimeWakeTerminalRespawn,
  resetWebRuntimeWakeTerminalRespawnForTests,
  shouldSkipWebRuntimeWakeTerminalRespawn
} from './web-runtime-wake-terminal-respawn'

// The wake-respawn latch is the initial-terminal bootstrap latch's twin: both stop one focus from
// issuing two creates for a workspace, and both are consulted from the same subscription closure.
// The bootstrap latch was re-keyed per environment for STA-4343 — a worktree id is `repoId::path`
// with no host component, so the same id can be live on two paired runtimes at once — and its
// teardown narrowed to one environment for STA-6173. This latch never got either change: it was a
// bare Set of worktree ids, and `clearWebSessionTabsTrackingForEnvironment` cleared ALL of it, one
// line above the bootstrap latch's correctly-scoped clear.

const ENV_A = 'env-a'
const ENV_B = 'env-b'
const WORKTREE = 'repo-a::worktree-a'

describe('wake-terminal respawn latch keyed per environment', () => {
  beforeEach(resetWebRuntimeWakeTerminalRespawnForTests)

  // STA-4343 shape: two paired runtimes can hold the same worktree id at once, so one runtime's
  // respawn must not suppress the other's — and one runtime's release must not free the other's.
  it('lets two environments hold the same worktree id independently', () => {
    expect(beginWebRuntimeWakeTerminalRespawn(ENV_A, WORKTREE)).toBe(true)

    // The sibling runtime's respawn is a different workspace, and must not be blocked by A's.
    expect(shouldSkipWebRuntimeWakeTerminalRespawn(ENV_B, WORKTREE)).toBe(false)
    expect(beginWebRuntimeWakeTerminalRespawn(ENV_B, WORKTREE)).toBe(true)

    // A's create settles. Only A's claim goes.
    endWebRuntimeWakeTerminalRespawn(ENV_A, WORKTREE)
    expect(shouldSkipWebRuntimeWakeTerminalRespawn(ENV_A, WORKTREE)).toBe(false)
    expect(shouldSkipWebRuntimeWakeTerminalRespawn(ENV_B, WORKTREE)).toBe(true)
  })

  // STA-6173 shape, the cross-environment door: tearing one environment down freed every other
  // environment's in-flight claim, so a fresh closure for the sibling could issue a second respawn
  // while the first create was still running.
  it('does not release a sibling environment’s claim when one environment is torn down', () => {
    expect(beginWebRuntimeWakeTerminalRespawn(ENV_A, WORKTREE)).toBe(true)
    expect(beginWebRuntimeWakeTerminalRespawn(ENV_B, WORKTREE)).toBe(true)

    clearWebRuntimeWakeTerminalRespawnForEnvironment(ENV_A)

    expect(shouldSkipWebRuntimeWakeTerminalRespawn(ENV_A, WORKTREE)).toBe(false)
    expect(shouldSkipWebRuntimeWakeTerminalRespawn(ENV_B, WORKTREE)).toBe(true)
    // A freshly installed sibling closure passes its own flag false, so only the surviving latch
    // stops it issuing a duplicate respawn.
    expect(beginWebRuntimeWakeTerminalRespawn(ENV_B, WORKTREE)).toBe(false)
  })

  it('drains the environment entry once its last worktree is released', () => {
    expect(beginWebRuntimeWakeTerminalRespawn(ENV_A, WORKTREE)).toBe(true)
    endWebRuntimeWakeTerminalRespawn(ENV_A, WORKTREE)
    expect(shouldSkipWebRuntimeWakeTerminalRespawn(ENV_A, WORKTREE)).toBe(false)
    expect(beginWebRuntimeWakeTerminalRespawn(ENV_A, WORKTREE)).toBe(true)
  })
})
