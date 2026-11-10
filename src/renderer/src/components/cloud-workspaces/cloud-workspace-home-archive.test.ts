import { describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))
vi.mock('../orca-cloud/cloud-workspace-actions', () => ({
  runArchiveCloudWorkspace: vi.fn(),
  runArchiveWithUndo: vi.fn(),
  runUnarchiveCloudWorkspace: vi.fn()
}))

import type { CloudWorkspace } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { archiveFromHome, unarchiveFromHome } from './cloud-workspace-home-archive'

const w = { id: 'sbx_1' } as CloudWorkspace

function deps(local: string | null) {
  return {
    localWorktreeId: vi.fn(async () => local),
    patchArchived: vi.fn(async () => ({ ok: true as const, value: {} as never })),
    archiveLocal: vi.fn(async () => undefined),
    // Commit immediately, as if the Undo window passed.
    archiveWithUndo: vi.fn(
      async (_key: string, options: { commit: () => Promise<{ ok: boolean }> }) =>
        (await options.commit()).ok
    ),
    unarchiveLocal: vi.fn(async () => true)
  }
}

describe('archive from the team list', () => {
  it('runs the sidebar sleep → archive (with Undo) for a workspace this desktop runs', async () => {
    const d = deps('wt-1')
    await archiveFromHome(w, 'Fix login', d as never)
    expect(d.archiveLocal).toHaveBeenCalledWith('wt-1', { name: 'Fix login' })
    expect(d.patchArchived).not.toHaveBeenCalled()
  })

  it('asks the control plane to archive (it stops the sandbox) for any other workspace, behind the Undo toast', async () => {
    const d = deps(null)
    await archiveFromHome(w, 'Fix login', d as never)
    expect(d.archiveWithUndo).toHaveBeenCalledWith(
      'home:sbx_1',
      expect.objectContaining({ name: 'Fix login' })
    )
    expect(d.patchArchived).toHaveBeenCalledWith('sbx_1', true)
    expect(d.archiveLocal).not.toHaveBeenCalled()
  })

  it('unarchives locally (wakes) or through the control plane (stays asleep)', async () => {
    const local = deps('wt-1')
    await unarchiveFromHome(w, 'Fix login', local as never)
    expect(local.unarchiveLocal).toHaveBeenCalledWith('wt-1')
    const remote = deps(null)
    await unarchiveFromHome(w, 'Fix login', remote as never)
    expect(remote.patchArchived).toHaveBeenCalledWith('sbx_1', false)
  })
})
