import { describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { TreeNode } from './file-explorer-types'
import { activateFileExplorerNode } from './useFileExplorerHandlers'

describe('activateFileExplorerNode', () => {
  const directoryNode: TreeNode = {
    name: 'src',
    path: '/repo/src',
    relativePath: 'src',
    isDirectory: true,
    depth: 0
  }
  const symlinkNode: TreeNode = {
    name: 'linked-docs',
    path: '/repo/linked-docs',
    relativePath: 'linked-docs',
    isDirectory: false,
    isSymlink: true,
    depth: 0,
    operationOwner: {
      kind: 'runtime',
      environmentId: 'runtime-env-1',
      executionHostId: 'runtime:runtime-env-1'
    }
  }

  it('selects filtered folders without mutating persisted expansion', async () => {
    const toggleDir = vi.fn()
    const setSelectedPath = vi.fn()

    await activateFileExplorerNode({
      node: directoryNode,
      activeWorktreeId: 'wt-1',
      openFile: vi.fn(),
      toggleDir,
      canToggleDirectories: false,
      loadDir: vi.fn(),
      statPath: vi.fn(),
      markPathAsDirectory: vi.fn(),
      setSelectedPath
    })

    expect(setSelectedPath).toHaveBeenCalledWith('/repo/src')
    expect(toggleDir).not.toHaveBeenCalled()
  })

  it('expands a symlink only after explicit activation proves it is a directory', async () => {
    const loadDir = vi.fn().mockResolvedValue(true)
    const markPathAsDirectory = vi.fn()
    const toggleDir = vi.fn()
    const openFile = vi.fn()

    await activateFileExplorerNode({
      node: symlinkNode,
      activeWorktreeId: 'wt-1',
      openFile,
      toggleDir,
      loadDir,
      statPath: vi.fn().mockResolvedValue({ isDirectory: true }),
      markPathAsDirectory,
      setSelectedPath: vi.fn()
    })

    expect(loadDir).toHaveBeenCalledTimes(1)
    expect(loadDir).toHaveBeenCalledWith('/repo/linked-docs', 0, {
      force: true,
      failOnError: true
    })
    expect(markPathAsDirectory).toHaveBeenCalledWith('/repo/linked-docs')
    expect(toggleDir).toHaveBeenCalledWith('wt-1', '/repo/linked-docs')
    expect(openFile).not.toHaveBeenCalled()
  })

  it('falls back to opening a symlink as a file when directory loading fails', async () => {
    const openFile = vi.fn()
    useAppStore.setState({
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-1',
            repoId: 'repo-1',
            path: '/repo',
            hostId: 'runtime:runtime-env-1'
          } as never
        ]
      }
    })

    await activateFileExplorerNode({
      node: symlinkNode,
      activeWorktreeId: 'wt-1',
      runtimeEnvironmentId: 'runtime-env-1',
      openFile,
      toggleDir: vi.fn(),
      loadDir: vi.fn(),
      statPath: vi.fn().mockResolvedValue({ isDirectory: false }),
      markPathAsDirectory: vi.fn(),
      setSelectedPath: vi.fn()
    })

    expect(openFile).toHaveBeenCalledWith(
      {
        filePath: '/repo/linked-docs',
        relativePath: 'linked-docs',
        worktreeId: 'wt-1',
        runtimeEnvironmentId: 'runtime-env-1',
        language: expect.any(String),
        mode: 'edit'
      },
      { preview: true, suppressActiveRuntimeFallback: false }
    )
  })

  it('opens local files without runtime fallback when no runtime owner is set', async () => {
    const fileNode: TreeNode = {
      name: 'README.md',
      path: '/repo/README.md',
      relativePath: 'README.md',
      isDirectory: false,
      depth: 0,
      operationOwner: { kind: 'local' }
    }
    const openFile = vi.fn()
    useAppStore.setState({
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' } as never]
      }
    })

    await activateFileExplorerNode({
      node: fileNode,
      activeWorktreeId: 'wt-1',
      runtimeEnvironmentId: null,
      openFile,
      toggleDir: vi.fn(),
      loadDir: vi.fn(),
      statPath: vi.fn(),
      markPathAsDirectory: vi.fn(),
      setSelectedPath: vi.fn()
    })

    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/repo/README.md',
        runtimeEnvironmentId: undefined
      }),
      { preview: true, suppressActiveRuntimeFallback: true }
    )
  })
})
