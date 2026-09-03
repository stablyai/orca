import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  scheduleRuntimeGraphSync: vi.fn(),
  setWebRuntimeTabProps: vi.fn()
}))

vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync: mocks.scheduleRuntimeGraphSync
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  setWebRuntimeTabProps: mocks.setWebRuntimeTabProps
}))

vi.mock('@/lib/terminal-worktree-route', () => ({
  resolveTerminalWorktreeRoute: () => ({ runtimeEnvironmentId: 'remote-1' })
}))

import { createTerminalTabAttentionActions } from './terminal-tab-attention'

describe('terminal custom title runtime mirror', () => {
  it('mirrors rename and clear mutations to the owning host tab', async () => {
    const setTabCustomLabel = vi.fn()
    let state = {
      tabsByWorktree: {
        'repo::/worktree': [{ id: 'terminal-1', customTitle: null }]
      },
      unifiedTabsByWorktree: {
        'repo::/worktree': [{ id: 'unified-1', entityId: 'terminal-1', contentType: 'terminal' }]
      },
      setTabCustomLabel
    }
    const set = (update: (current: typeof state) => Partial<typeof state>): void => {
      state = { ...state, ...update(state) }
    }
    const actions = createTerminalTabAttentionActions(set as never, (() => state) as never)

    actions.setTabCustomTitle('terminal-1', 'Shared build')
    await vi.waitFor(() => expect(mocks.setWebRuntimeTabProps).toHaveBeenCalledTimes(1))
    actions.setTabCustomTitle('terminal-1', null)

    await vi.waitFor(() => expect(mocks.setWebRuntimeTabProps).toHaveBeenCalledTimes(2))
    expect(mocks.setWebRuntimeTabProps.mock.calls).toEqual([
      [
        {
          worktreeId: 'repo::/worktree',
          tabId: 'unified-1',
          customTitle: 'Shared build',
          previousCustomTitle: null
        }
      ],
      [
        {
          worktreeId: 'repo::/worktree',
          tabId: 'unified-1',
          customTitle: null,
          previousCustomTitle: 'Shared build'
        }
      ]
    ])
    expect(setTabCustomLabel).toHaveBeenLastCalledWith('unified-1', null, undefined)
  })
})
