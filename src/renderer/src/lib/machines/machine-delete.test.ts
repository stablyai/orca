import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import type { MachineMatch } from './machine-host-match'

const mocks = vi.hoisted(() => ({ removeWorktree: vi.fn(), warning: vi.fn() }))
vi.mock('sonner', () => ({ toast: { warning: mocks.warning } }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ removeWorktree: mocks.removeWorktree }) }
}))

import { deleteMachineWithWorktrees } from './machine-delete'

const machines = { delete: vi.fn() }
const match: MachineMatch = {
  environmentId: null,
  snapshot: { providerKey: 'plugin:p/o', name: 'Omarchy', machines: [], pendingCreates: [] },
  machine: {
    id: 'm',
    name: 'box',
    lifetime: 'temporary',
    state: 'running',
    createdAt: '2026-10-19T08:00:00.000Z',
    providerKey: 'plugin:p/o',
    lastSeenAt: 0
  }
}
const worktree = (id: string): Pick<Worktree, 'id' | 'repoId' | 'hostId'> => ({
  id,
  repoId: 'r',
  hostId: 'runtime:env-1'
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { api: { machines } })
})

describe('deleteMachineWithWorktrees', () => {
  it('forgets the worktrees once the machine is gone', async () => {
    machines.delete.mockResolvedValue({ ok: true, value: { ...match.machine, state: 'gone' } })
    mocks.removeWorktree.mockResolvedValue({ ok: true })

    expect(await deleteMachineWithWorktrees(match, [worktree('a'), worktree('b')], [])).toEqual({
      ok: true
    })
    expect(mocks.removeWorktree).toHaveBeenCalledWith(
      { id: 'a', executionHostId: 'runtime:env-1' },
      false,
      { mode: 'forget-local' }
    )
    expect(mocks.warning).not.toHaveBeenCalled()
  })

  it('keeps the worktrees when the delete fails, and says why plainly', async () => {
    machines.delete.mockResolvedValue({ ok: false, code: 'conflict', message: 'busy' })

    expect(await deleteMachineWithWorktrees(match, [worktree('a')], [])).toEqual({
      ok: false,
      error: 'Another action is running on box.'
    })
    expect(mocks.removeWorktree).not.toHaveBeenCalled()
  })

  it('keeps the worktrees when the provider still lists the machine', async () => {
    machines.delete.mockResolvedValue({ ok: true, value: { ...match.machine, state: 'error' } })

    expect(await deleteMachineWithWorktrees(match, [worktree('a')], [])).toEqual({
      ok: false,
      error: 'box wasn’t deleted. The provider still lists it as Error.'
    })
    expect(mocks.removeWorktree).not.toHaveBeenCalled()
  })

  it('says which worktrees could not be removed', async () => {
    machines.delete.mockResolvedValue({ ok: true, value: { ...match.machine, state: 'gone' } })
    mocks.removeWorktree.mockResolvedValueOnce({ ok: false, error: 'x' })

    await deleteMachineWithWorktrees(match, [worktree('a')], [])
    expect(mocks.warning).toHaveBeenCalledWith(
      'Deleted box, but 1 of its worktrees are still listed. Remove them from their menu.'
    )
  })
})
