import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { dispatchWebRuntimeInitialTerminalBootstrap } from './web-runtime-initial-terminal-bootstrap-dispatch'
import {
  isWebRuntimeInitialTerminalBootstrapInFlight,
  releaseWebRuntimeInitialTerminalBootstrapOnMirrorFrame,
  resetWebRuntimeInitialTerminalBootstrapForTests
} from './web-runtime-initial-terminal-bootstrap'

const createTerminal = vi.hoisted(() => vi.fn())
vi.mock('./web-runtime-session', () => ({ createWebRuntimeSessionTerminal: createTerminal }))

// What this pins: a throw AFTER the create resolves must not leave the latch in `creating`.
// `releaseWebRuntimeInitialTerminalBootstrapOnMirrorFrame` only ever clears `awaiting-mirror`, so
// a stranded `creating` claim survives every later mirror frame and makes the workspace refuse to
// bootstrap a terminal for the rest of the environment's life.

const ENV_ID = 'env-bootstrap-dispatch'
const WORKTREE_ID = 'repo-1::/w/one'

describe('dispatchWebRuntimeInitialTerminalBootstrap', () => {
  beforeEach(() => {
    resetWebRuntimeInitialTerminalBootstrapForTests()
    createTerminal.mockReset()
  })

  afterEach(() => {
    resetWebRuntimeInitialTerminalBootstrapForTests()
    vi.restoreAllMocks()
  })

  it('releases the latch when the post-create store read throws', async () => {
    createTerminal.mockResolvedValue({ status: 'created' })
    const getState = vi.spyOn(useAppStore, 'getState').mockImplementation(() => {
      throw new Error('store read blew up')
    })

    await expect(dispatchWebRuntimeInitialTerminalBootstrap(ENV_ID, WORKTREE_ID)).rejects.toThrow(
      'store read blew up'
    )
    getState.mockRestore()

    expect(isWebRuntimeInitialTerminalBootstrapInFlight(ENV_ID, WORKTREE_ID)).toBe(false)
    // A mirror frame cannot rescue a stranded `creating` claim, so the latch had to release itself.
    releaseWebRuntimeInitialTerminalBootstrapOnMirrorFrame(ENV_ID, WORKTREE_ID)
    expect(isWebRuntimeInitialTerminalBootstrapInFlight(ENV_ID, WORKTREE_ID)).toBe(false)

    createTerminal.mockResolvedValue({ status: 'created' })
    await dispatchWebRuntimeInitialTerminalBootstrap(ENV_ID, WORKTREE_ID)
    expect(createTerminal).toHaveBeenCalledTimes(2)
  })
})
