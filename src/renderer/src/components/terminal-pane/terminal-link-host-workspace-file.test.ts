import { describe, expect, it, vi } from 'vitest'
import { openDetectedFilePath } from './terminal-link-handlers'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import {
  flushDoubleRaf,
  installTerminalLinkTestEnvironment
} from './terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()
const { storeState, statMock, openFileMock, runtimeEnvironmentCallMock } = doubles

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

installTerminalLinkTestEnvironment(doubles)

const featureWorktree = {
  worktreeId: 'wt-feat',
  worktreePath: '/repo/.orca/worktrees/feat-x',
  runtimeEnvironmentId: 'env-1'
}

function hostAnswers(result: unknown): void {
  runtimeEnvironmentCallMock.mockResolvedValueOnce({
    id: 'rpc-1',
    ok: true,
    result,
    _meta: { runtimeId: 'remote-runtime' }
  })
}

describe('a paired-server link outside its own workspace', () => {
  it('opens a main-repo file in the workspace the host says holds it', async () => {
    hostAnswers({
      worktree: 'wt-main',
      relativePath: 'src/index.ts',
      absolutePath: '/repo/src/index.ts',
      exists: true,
      isDirectory: false
    })

    openDetectedFilePath('/repo/src/index.ts', 3, null, featureWorktree)
    await flushDoubleRaf()

    expect(runtimeEnvironmentCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'files.resolveTerminalPath',
        params: { worktree: 'id:wt-feat', pathText: '/repo/src/index.ts', crossWorkspace: true }
      })
    )
    expect(statMock).not.toHaveBeenCalled()
    expect(activateAndRevealWorkspace).toHaveBeenCalledWith('wt-main', {
      providesInitialSurface: true,
      executionHostId: 'runtime:env-1'
    })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/repo/src/index.ts',
        relativePath: 'src/index.ts',
        worktreeId: 'wt-main',
        runtimeEnvironmentId: 'env-1'
      }),
      { forceContentReload: true }
    )
  })

  it("opens the host's spelling of the path so the tab stays a workspace file", async () => {
    hostAnswers({
      worktree: 'wt-main',
      relativePath: 'src/index.ts',
      absolutePath: '/repo/src/index.ts',
      exists: true,
      isDirectory: false
    })

    openDetectedFilePath('/repo/lib/../src/index.ts', null, null, featureWorktree)
    await flushDoubleRaf()

    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/repo/src/index.ts',
        relativePath: 'src/index.ts',
        worktreeId: 'wt-main'
      }),
      { forceContentReload: true }
    )
  })

  it('says the host has no workspace for a path outside all of them', async () => {
    hostAnswers({
      worktree: 'wt-feat',
      relativePath: null,
      absolutePath: '/etc/hosts',
      exists: false,
      isDirectory: false
    })
    const onOpenFailure = vi.fn()

    openDetectedFilePath('/etc/hosts', null, null, { ...featureWorktree, onOpenFailure })
    await flushDoubleRaf()

    expect(openFileMock).not.toHaveBeenCalled()
    expect(onOpenFailure).toHaveBeenCalledWith({
      verdict: 'unverifiable',
      error: new Error('/etc/hosts is outside every workspace on its host')
    })
  })

  it('reports a sibling-workspace file the host verified absent as missing', async () => {
    hostAnswers({
      worktree: 'wt-y',
      relativePath: 'src/gone.ts',
      absolutePath: '/repo/.orca/worktrees/feat-y/src/gone.ts',
      exists: false,
      isDirectory: false
    })
    const onOpenFailure = vi.fn()

    openDetectedFilePath('/repo/.orca/worktrees/feat-y/src/gone.ts', null, null, {
      ...featureWorktree,
      onOpenFailure
    })
    await flushDoubleRaf()

    expect(openFileMock).not.toHaveBeenCalled()
    expect(onOpenFailure).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'missing' }))
  })

  it('keeps a file inside its own workspace on the plain stat path', async () => {
    hostAnswers({ size: 1, isDirectory: false, mtime: 1 })

    openDetectedFilePath('/repo/.orca/worktrees/feat-x/a.ts', null, null, featureWorktree)
    await flushDoubleRaf()

    expect(runtimeEnvironmentCallMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.stat' })
    )
    expect(runtimeEnvironmentCallMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.resolveTerminalPath' })
    )
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'a.ts', worktreeId: 'wt-feat' }),
      { forceContentReload: true }
    )
  })
})
