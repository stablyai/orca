import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  statUserOpenedPath: vi.fn(),
  openFile: vi.fn(),
  setActiveTabType: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/lib/ssh-mutation-expectation', () => ({
  captureWorktreeSshMutationExpectation: () => ({})
}))
vi.mock('@/lib/file-owner-runtime-target', () => {
  const getRuntimeTargetForFileOwner = (
    _state: unknown,
    _worktreeId: string | null | undefined,
    _runtimeEnvironmentId: string | null | undefined
  ) => ({ kind: 'local' as const })
  return {
    FILE_OWNER_UNRESOLVED_MESSAGE: 'unresolved',
    getRuntimeTargetForFileOwner,
    requireRuntimeTargetForFileOwner: getRuntimeTargetForFileOwner,
    getRuntimeTargetForWorktreeOwner: (state: unknown, worktreeId: string | null | undefined) =>
      getRuntimeTargetForFileOwner(state, worktreeId, undefined)
  }
})
vi.mock('@/lib/user-opened-local-path', () => ({ statUserOpenedPath: mocks.statUserOpenedPath }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: {},
      activeWorktreeId: 'wt-1',
      getKnownWorktreeById: () => ({ id: 'wt-1', path: '/repo' }),
      setActiveTabType: mocks.setActiveTabType,
      openFile: mocks.openFile
    })
  }
}))

import { captureEditorFileDropOpen } from './editor-dropped-file-open'

beforeEach(() => {
  mocks.statUserOpenedPath.mockReset()
  mocks.openFile.mockReset()
})

async function dropOnTabStrip(path: string): Promise<void> {
  await captureEditorFileDropOpen({ worktreeId: 'wt-1' })([path])
  await vi.waitFor(() => expect(mocks.openFile).toHaveBeenCalledTimes(1))
}

describe('dropping a project file on the tab strip', () => {
  it('opens a link that leads out of the project by its absolute path', async () => {
    mocks.statUserOpenedPath.mockResolvedValue({ isDirectory: false, escapesWorktree: true })

    await dropOnTabStrip('/repo/docs-link/secret.md')

    expect(mocks.openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/repo/docs-link/secret.md',
        relativePath: '/repo/docs-link/secret.md'
      })
    )
  })

  it('keeps an ordinary project file project-relative', async () => {
    mocks.statUserOpenedPath.mockResolvedValue({ isDirectory: false, escapesWorktree: false })

    await dropOnTabStrip('/repo/docs/plain.md')

    expect(mocks.openFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/repo/docs/plain.md', relativePath: 'docs/plain.md' })
    )
  })
})
