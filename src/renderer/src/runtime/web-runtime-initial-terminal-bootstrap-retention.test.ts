import { beforeEach, describe, expect, it } from 'vitest'
import {
  beginWebRuntimeInitialTerminalBootstrap,
  clearWebRuntimeInitialTerminalBootstrapsForEnvironment,
  countWebRuntimeInitialTerminalBootstrapEntriesForTests,
  countWebRuntimeInitialTerminalBootstrapEnvironmentsForTests,
  endWebRuntimeInitialTerminalBootstrap,
  markWebRuntimeInitialTerminalBootstrapAwaitingMirror,
  releaseWebRuntimeInitialTerminalBootstrapOnMirrorFrame,
  resetWebRuntimeInitialTerminalBootstrapForTests
} from './web-runtime-initial-terminal-bootstrap'

// This latch is module-level, so it outlives every closure and every workspace. It is keyed by
// environment AND worktree — two ids that both stop recurring once the workspace is destroyed or
// the runtime unpairs — so what matters is that the nested map shrinks back, including the outer
// environment entry. An empty inner Map left behind for a removed environment is still a leak.

const ENV_A = 'env-bootstrap-a'
const ENV_B = 'env-bootstrap-b'

describe('web runtime initial terminal bootstrap retention', () => {
  beforeEach(() => {
    resetWebRuntimeInitialTerminalBootstrapForTests()
  })

  it('returns to baseline across workspace create/destroy churn', () => {
    for (let round = 0; round < 1000; round += 1) {
      const environmentId = round % 2 === 0 ? ENV_A : ENV_B
      const worktreeId = `repo-1::worktree-${round}`
      expect(beginWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)).toBe(true)
      endWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)
    }
    expect(countWebRuntimeInitialTerminalBootstrapEntriesForTests()).toBe(0)
    // The outer environment entry must go too, not just the inner worktree key.
    expect(countWebRuntimeInitialTerminalBootstrapEnvironmentsForTests()).toBe(0)
  })

  it('returns to baseline when every create parks on the mirror before its frame lands', () => {
    for (let round = 0; round < 1000; round += 1) {
      const worktreeId = `repo-1::worktree-${round}`
      beginWebRuntimeInitialTerminalBootstrap(ENV_A, worktreeId)
      markWebRuntimeInitialTerminalBootstrapAwaitingMirror(ENV_A, worktreeId)
      releaseWebRuntimeInitialTerminalBootstrapOnMirrorFrame(ENV_A, worktreeId)
    }
    expect(countWebRuntimeInitialTerminalBootstrapEntriesForTests()).toBe(0)
    expect(countWebRuntimeInitialTerminalBootstrapEnvironmentsForTests()).toBe(0)
  })

  it('releases every key an environment held when that environment tears down', () => {
    for (let index = 0; index < 100; index += 1) {
      beginWebRuntimeInitialTerminalBootstrap(ENV_A, `repo-1::worktree-${index}`)
      beginWebRuntimeInitialTerminalBootstrap(ENV_B, `repo-1::worktree-${index}`)
    }
    expect(countWebRuntimeInitialTerminalBootstrapEntriesForTests()).toBe(200)

    // A create still in flight is exactly what teardown must reclaim: nothing will ever
    // resolve it once the runtime is gone, so nothing else would remove these keys.
    clearWebRuntimeInitialTerminalBootstrapsForEnvironment(ENV_A)
    expect(countWebRuntimeInitialTerminalBootstrapEntriesForTests()).toBe(100)
    expect(countWebRuntimeInitialTerminalBootstrapEnvironmentsForTests()).toBe(1)

    clearWebRuntimeInitialTerminalBootstrapsForEnvironment(ENV_B)
    expect(countWebRuntimeInitialTerminalBootstrapEntriesForTests()).toBe(0)
    expect(countWebRuntimeInitialTerminalBootstrapEnvironmentsForTests()).toBe(0)
  })
})
