import { beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnIpcPty } from './ipc-pty-spawn-request'

const spawn = vi.fn().mockResolvedValue({ id: 'pty-1' })

beforeEach(() => {
  spawn.mockClear()
  ;(globalThis as unknown as { window: { api: { pty: { spawn: typeof spawn } } } }).window = {
    api: { pty: { spawn } }
  }
})

describe('spawnIpcPty', () => {
  // Why: a cold-restore agent resume carries the agent's own working directory on the connect
  // options, not on the pane's transport baseline. Reading only the baseline resumes the session
  // in the pane's worktree, which is the failure STA-5804 exists to fix.
  it('prefers the connect-time cwd over the pane transport baseline', async () => {
    await spawnIpcPty({ cwd: '/repo/wt-1', worktreeId: 'wt-1' }, {
      url: '',
      cwd: '/repo/wt-1/packages/api',
      callbacks: {}
    } as never)

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/repo/wt-1/packages/api' }))
  })

  it('keeps the pane transport baseline when the connect options name no cwd', async () => {
    await spawnIpcPty({ cwd: '/repo/wt-1', worktreeId: 'wt-1' }, {
      url: '',
      callbacks: {}
    } as never)

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/repo/wt-1' }))
  })
})
