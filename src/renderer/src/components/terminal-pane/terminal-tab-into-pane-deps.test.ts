// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveHostMock } = vi.hoisted(() => ({ resolveHostMock: vi.fn() }))

vi.mock('@/lib/resolved-worktree-execution-host', () => ({
  getResolvedExecutionHostIdForWorktree: resolveHostMock
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))

import { createTerminalTabIntoPaneDeps } from './terminal-tab-into-pane-deps'

describe('createTerminalTabIntoPaneDeps readMainSession', () => {
  const originalApi = window.api
  const sessionGet = vi.fn()

  beforeEach(() => {
    sessionGet.mockReset().mockResolvedValue(null)
    resolveHostMock.mockReset()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the deps read only session.get.
    window.api = { session: { get: sessionGet } } as unknown as typeof window.api
  })

  afterEach(() => {
    window.api = originalApi
  })

  it("reads an SSH workspace's session from its host", async () => {
    resolveHostMock.mockReturnValue('ssh:conn-1')

    await createTerminalTabIntoPaneDeps().readMainSession('wt-remote')

    expect(resolveHostMock).toHaveBeenCalledWith(expect.anything(), 'wt-remote')
    expect(sessionGet).toHaveBeenCalledWith('ssh:conn-1')
  })

  it('reads the local session when the host is not resolved yet', async () => {
    resolveHostMock.mockReturnValue(null)

    await createTerminalTabIntoPaneDeps().readMainSession('wt-local')

    expect(sessionGet).toHaveBeenCalledWith(undefined)
  })
})
