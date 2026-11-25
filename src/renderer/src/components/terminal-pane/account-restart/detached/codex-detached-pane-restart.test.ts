import { describe, expect, it, vi } from 'vitest'

const { state } = vi.hoisted(() => ({
  state: {
    tabsByWorktree: { workspace: [{ id: 'tab', ptyId: 'pty' }] },
    codexRestartNoticeByPtyId: { pty: { restartRequested: true } },
    reopenCodexRestartPrompt: vi.fn(),
    clearTabPtyId: vi.fn(),
    queueTabStartupCommand: vi.fn()
  }
}))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => state } }))
vi.mock('../../pty-transport/delivery/pty-dispatcher', () => ({}))

import { executeDetachedCodexPaneRestart } from './codex-detached-pane-restart'

describe('detached account restart', () => {
  it('keeps the session running when the pane has no stable identity', async () => {
    const kill = vi.fn()
    vi.stubGlobal('window', { api: { pty: { kill } } })
    await executeDetachedCodexPaneRestart(
      {
        worktreeId: 'workspace',
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the no-leaf branch reads no tab fields.
        tab: { id: 'tab', ptyId: 'pty' } as never,
        leafId: null,
        generation: 0
      },
      'pty',
      'codex'
    )
    expect(state.reopenCodexRestartPrompt).toHaveBeenCalledWith('pty')
    expect(state.clearTabPtyId).not.toHaveBeenCalled()
    expect(state.queueTabStartupCommand).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
