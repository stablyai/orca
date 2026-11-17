import { describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))
vi.mock('../orca-cloud/cloud-workspace-actions', () => ({
  runArchiveCloudWorkspace: vi.fn(),
  runArchiveWithUndo: vi.fn(),
  runUnarchiveCloudWorkspace: vi.fn()
}))

import {
  archiveFromHome,
  deleteFromHome,
  destroyFromHome,
  sleepFromHome,
  unarchiveFromHome,
  type HomeArchiveDeps
} from './cloud-workspace-home-archive'
import { workspace } from './cloud-workspaces.test-fixture'

const w = workspace({ id: 'sbx_1' })

function deps(local: string | null) {
  const patchArchived = vi.fn<HomeArchiveDeps['patchArchived']>(async () => ({
    ok: true,
    value: w
  }))
  const archiveWithUndo = vi.fn<HomeArchiveDeps['archiveWithUndo']>(async (_key, options) => {
    // Commit immediately, as if the Undo window passed.
    return (await options.commit()).ok
  })
  const d = {
    localWorktreeId: vi.fn<HomeArchiveDeps['localWorktreeId']>(async () => local),
    patchArchived,
    archiveLocal: vi.fn<HomeArchiveDeps['archiveLocal']>(async () => undefined),
    archiveWithUndo,
    unarchiveLocal: vi.fn<HomeArchiveDeps['unarchiveLocal']>(async () => true)
  } satisfies HomeArchiveDeps
  return d
}

describe('archive from the team list', () => {
  it('runs the sidebar sleep → archive (with Undo) for a workspace this desktop runs', async () => {
    const d = deps('wt-1')
    await archiveFromHome(w, 'Fix login', d)
    expect(d.archiveLocal).toHaveBeenCalledWith('wt-1', { name: 'Fix login' })
    expect(d.patchArchived).not.toHaveBeenCalled()
  })

  it('asks the control plane to archive (it stops the sandbox) for any other workspace, behind the Undo toast', async () => {
    const d = deps(null)
    await archiveFromHome(w, 'Fix login', d)
    expect(d.archiveWithUndo).toHaveBeenCalledWith(
      'home:sbx_1',
      expect.objectContaining({ name: 'Fix login' })
    )
    expect(d.patchArchived).toHaveBeenCalledWith('sbx_1', true)
    expect(d.archiveLocal).not.toHaveBeenCalled()
  })

  it('unarchives locally (wakes) or through the control plane (stays asleep)', async () => {
    const local = deps('wt-1')
    await unarchiveFromHome(w, 'Fix login', local)
    expect(local.unarchiveLocal).toHaveBeenCalledWith('wt-1')
    const remote = deps(null)
    await unarchiveFromHome(w, 'Fix login', remote)
    expect(remote.patchArchived).toHaveBeenCalledWith('sbx_1', false)
  })
})

describe('sleep and delete from the team list', () => {
  it('sleeps and deletes a workspace this desktop does not run through the control plane', async () => {
    const sleep = vi.fn(async () => ({ ok: true as const, value: undefined }))
    const destroy = vi.fn(async () => ({ ok: true as const, value: undefined }))
    vi.stubGlobal('window', {
      api: { cloudWorkspaces: { localWorkspaces: async () => [], sleep, destroy } }
    })
    await sleepFromHome(w, 'Fix login')
    expect(sleep).toHaveBeenCalledWith('sbx_1')
    const confirm = vi.fn()
    await deleteFromHome(w, confirm)
    // Deleting asks first; the control plane only deletes after the confirmation.
    expect(confirm).toHaveBeenCalledWith({ kind: 'delete', workspace: w })
    expect(destroy).not.toHaveBeenCalled()
    await destroyFromHome(w, 'Fix login')
    expect(destroy).toHaveBeenCalledWith('sbx_1')
    vi.unstubAllGlobals()
  })
})
