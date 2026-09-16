import { describe, expect, it, vi } from 'vitest'

const ownerMocks = vi.hoisted(() => ({
  getConnectionIdForFile: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(),
  getConnectionIdForFile: ownerMocks.getConnectionIdForFile
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: ownerMocks.getRuntimeEnvironmentIdForWorktree
}))

import {
  isTerminalRichInputPathContextCurrent,
  navigateTerminalRichInputPath,
  resolveTerminalRichInputAbsolutePath
} from './terminal-rich-input-path-navigation'

const context = {
  path: 'src/app.ts',
  connectionId: 'ssh-1',
  worktreeId: 'worktree-1',
  worktreePath: '/repo',
  runtimeEnvironmentId: null
}

describe('terminal rich input path navigation', () => {
  it('resolves relative paths against POSIX and Windows workspace roots', () => {
    expect(resolveTerminalRichInputAbsolutePath('src/app.ts', '/repo')).toBe('/repo/src/app.ts')
    expect(resolveTerminalRichInputAbsolutePath('src\\app.ts', 'C:\\repo')).toBe(
      'C:/repo/src/app.ts'
    )
    expect(resolveTerminalRichInputAbsolutePath('/tmp/image.png', '/repo')).toBe('/tmp/image.png')
  })

  it('opens files in Orca with their workspace ownership', async () => {
    const openFile = vi.fn()
    const revealDirectory = vi.fn()

    await navigateTerminalRichInputPath(context, {
      inspectPath: vi.fn().mockResolvedValue('file'),
      openFile,
      revealDirectory
    })

    expect(openFile).toHaveBeenCalledWith('/repo/src/app.ts', {
      connectionId: 'ssh-1',
      worktreeId: 'worktree-1',
      worktreePath: '/repo',
      runtimeEnvironmentId: null
    })
    expect(revealDirectory).not.toHaveBeenCalled()
  })

  it('reveals directories in Orca instead of opening an external editor', async () => {
    const openFile = vi.fn()
    const revealDirectory = vi.fn()

    await navigateTerminalRichInputPath(
      { ...context, path: 'src' },
      {
        inspectPath: vi.fn().mockResolvedValue('directory'),
        openFile,
        revealDirectory
      }
    )

    expect(revealDirectory).toHaveBeenCalledWith('/repo/src', {
      ...context,
      path: 'src'
    })
    expect(openFile).not.toHaveBeenCalled()
  })

  it('checks the canonical worktree runtime route instead of the focused runtime', () => {
    ownerMocks.getConnectionIdForFile.mockReturnValue('ssh-1')
    ownerMocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue('env-B')

    expect(
      isTerminalRichInputPathContextCurrent(
        { ...context, path: 'src', runtimeEnvironmentId: 'env-A' },
        '/repo/src'
      )
    ).toBe(false)
    expect(ownerMocks.getConnectionIdForFile).toHaveBeenCalledWith('worktree-1', '/repo/src')
  })

  it('does not reveal a directory through a replacement workspace route', async () => {
    const revealDirectory = vi.fn()

    await navigateTerminalRichInputPath(
      { ...context, path: 'src' },
      {
        inspectPath: vi.fn().mockResolvedValue('directory'),
        isContextCurrent: vi.fn().mockReturnValue(false),
        openFile: vi.fn(),
        revealDirectory
      }
    )

    expect(revealDirectory).not.toHaveBeenCalled()
  })

  it('does nothing when a path can no longer be inspected', async () => {
    const openFile = vi.fn()
    const revealDirectory = vi.fn()

    await navigateTerminalRichInputPath(context, {
      inspectPath: vi.fn().mockResolvedValue(null),
      openFile,
      revealDirectory
    })

    expect(openFile).not.toHaveBeenCalled()
    expect(revealDirectory).not.toHaveBeenCalled()
  })
})
