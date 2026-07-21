// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { createFileExplorerRowProjection } from './file-explorer-row-projection'
import type { TreeNode } from './file-explorer-types'
import {
  getFileExplorerGitignoreEntries,
  performFileExplorerGitignoreAction,
  useFileExplorerGitignore
} from './useFileExplorerGitignore'

const { appendRuntimeGitignoreEntries, refreshGitStatusForWorktree } = vi.hoisted(() => ({
  appendRuntimeGitignoreEntries: vi.fn(),
  refreshGitStatusForWorktree: vi.fn()
}))

vi.mock('@/runtime/runtime-git-client', () => ({
  appendRuntimeGitignoreEntries
}))

vi.mock('./git-status-refresh', () => ({
  refreshGitStatusForWorktree
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn()
  }
}))

const directoryNode: TreeNode = {
  name: 'generated',
  path: '/repo/generated',
  relativePath: 'generated',
  isDirectory: true,
  depth: 0
}
const childNode: TreeNode = {
  name: 'bundle.js',
  path: '/repo/generated/bundle.js',
  relativePath: 'generated/bundle.js',
  isDirectory: false,
  depth: 1
}
const siblingNode: TreeNode = {
  name: 'secret.env',
  path: '/repo/secret.env',
  relativePath: 'secret.env',
  isDirectory: false,
  depth: 0
}
const context = {
  settings: { activeRuntimeEnvironmentId: null },
  worktreeId: 'wt-1',
  worktreePath: '/repo'
}

beforeEach(() => {
  appendRuntimeGitignoreEntries.mockReset()
  refreshGitStatusForWorktree.mockReset().mockResolvedValue(undefined)
  vi.mocked(toast.success).mockReset()
  vi.mocked(toast.info).mockReset()
  vi.mocked(toast.warning).mockReset()
  vi.mocked(toast.error).mockReset()
})

describe('getFileExplorerGitignoreEntries', () => {
  const projection = createFileExplorerRowProjection([directoryNode, childNode, siblingNode])

  it('uses the current multi-selection and removes children covered by a selected directory', () => {
    const result = getFileExplorerGitignoreEntries(
      childNode,
      new Set([directoryNode.path, childNode.path, siblingNode.path]),
      projection
    )

    expect(result).toEqual([
      { relativePath: 'generated', isDirectory: true },
      { relativePath: 'secret.env', isDirectory: false }
    ])
  })

  it('uses only the context-clicked node when it is outside the current selection', () => {
    const result = getFileExplorerGitignoreEntries(
      siblingNode,
      new Set([directoryNode.path, childNode.path]),
      projection
    )

    expect(result).toEqual([{ relativePath: 'secret.env', isDirectory: false }])
  })

  it('normalizes Windows separators before sending entries to the host', () => {
    const windowsNode = {
      ...childNode,
      path: 'C:\\repo\\generated\\bundle.js',
      relativePath: 'generated\\bundle.js'
    }
    const result = getFileExplorerGitignoreEntries(
      windowsNode,
      new Set([windowsNode.path]),
      createFileExplorerRowProjection([windowsNode])
    )

    expect(result).toEqual([{ relativePath: 'generated/bundle.js', isDirectory: false }])
  })
})

describe('performFileExplorerGitignoreAction', () => {
  it('reports mixed results and refreshes both explorer data sources', async () => {
    appendRuntimeGitignoreEntries.mockResolvedValue({
      added: ['generated'],
      alreadyPresent: ['secret.env']
    })
    const refreshTree = vi.fn().mockResolvedValue(undefined)
    const refreshGitStatus = vi.fn().mockResolvedValue(undefined)

    await performFileExplorerGitignoreAction({
      context,
      entries: [
        { relativePath: 'generated', isDirectory: true },
        { relativePath: 'secret.env', isDirectory: false }
      ],
      refreshTree,
      refreshGitStatus
    })

    expect(refreshTree).toHaveBeenCalledTimes(1)
    expect(refreshGitStatus).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith('Updated .gitignore: 1 added, 1 already present')
  })

  it('uses plural feedback when every selected entry has the same outcome', async () => {
    appendRuntimeGitignoreEntries.mockResolvedValue({
      added: ['generated', 'secret.env'],
      alreadyPresent: []
    })
    const refreshTree = vi.fn().mockResolvedValue(undefined)
    const refreshGitStatus = vi.fn().mockResolvedValue(undefined)
    const entries = [
      { relativePath: 'generated', isDirectory: true },
      { relativePath: 'secret.env', isDirectory: false }
    ]

    await performFileExplorerGitignoreAction({
      context,
      entries,
      refreshTree,
      refreshGitStatus
    })
    expect(toast.success).toHaveBeenCalledWith('Added 2 items to .gitignore')

    appendRuntimeGitignoreEntries.mockResolvedValue({
      added: [],
      alreadyPresent: ['generated', 'secret.env']
    })
    await performFileExplorerGitignoreAction({
      context,
      entries,
      refreshTree,
      refreshGitStatus
    })
    expect(toast.info).toHaveBeenCalledWith('2 items are already in .gitignore')
  })

  it('distinguishes existing entries, write failures, and refresh failures', async () => {
    appendRuntimeGitignoreEntries.mockResolvedValue({ added: [], alreadyPresent: ['generated'] })
    await performFileExplorerGitignoreAction({
      context,
      entries: [{ relativePath: 'generated', isDirectory: true }],
      refreshTree: vi.fn().mockResolvedValue(undefined),
      refreshGitStatus: vi.fn().mockResolvedValue(undefined)
    })
    expect(toast.info).toHaveBeenCalledWith("'generated' is already in .gitignore")

    appendRuntimeGitignoreEntries.mockResolvedValue({ added: ['generated'], alreadyPresent: [] })
    await performFileExplorerGitignoreAction({
      context,
      entries: [{ relativePath: 'generated', isDirectory: true }],
      refreshTree: vi.fn(() => {
        throw new Error('refresh failed')
      }),
      refreshGitStatus: vi.fn().mockResolvedValue(undefined)
    })
    expect(toast.success).toHaveBeenCalledWith("Added 'generated' to .gitignore")
    expect(toast.warning).toHaveBeenCalledWith(
      'Updated .gitignore, but could not refresh the File Explorer'
    )

    appendRuntimeGitignoreEntries.mockRejectedValue(new Error('permission denied'))
    const refreshTree = vi.fn()
    await performFileExplorerGitignoreAction({
      context,
      entries: [{ relativePath: 'generated', isDirectory: true }],
      refreshTree,
      refreshGitStatus: vi.fn()
    })
    expect(toast.error).toHaveBeenCalledWith('permission denied')
    expect(refreshTree).not.toHaveBeenCalled()
  })
})

describe('useFileExplorerGitignore', () => {
  it('does nothing when the active workspace is not a Git repository', async () => {
    const hook = renderHook(() =>
      useFileExplorerGitignore({
        enabled: false,
        context,
        selectedPaths: new Set([directoryNode.path]),
        rowProjection: createFileExplorerRowProjection([directoryNode]),
        refreshTree: vi.fn()
      })
    )

    await act(async () => {
      await hook.result.current.addToGitignore(directoryNode)
    })

    expect(appendRuntimeGitignoreEntries).not.toHaveBeenCalled()
    expect(hook.result.current.isAddingToGitignore).toBe(false)
  })

  it('keeps the action pending and ignores duplicate activation until completion', async () => {
    let resolveAppend!: (value: { added: string[]; alreadyPresent: string[] }) => void
    appendRuntimeGitignoreEntries.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAppend = resolve
        })
    )
    const refreshTree = vi.fn().mockResolvedValue(undefined)
    const rowProjection = createFileExplorerRowProjection([directoryNode])
    const hook = renderHook(() =>
      useFileExplorerGitignore({
        enabled: true,
        context,
        selectedPaths: new Set([directoryNode.path]),
        rowProjection,
        refreshTree
      })
    )

    let firstRequest!: Promise<void>
    await act(async () => {
      firstRequest = hook.result.current.addToGitignore(directoryNode)
      await Promise.resolve()
    })
    expect(hook.result.current.isAddingToGitignore).toBe(true)

    await act(async () => {
      await hook.result.current.addToGitignore(directoryNode)
    })
    expect(appendRuntimeGitignoreEntries).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveAppend({ added: ['generated'], alreadyPresent: [] })
      await firstRequest
    })
    expect(hook.result.current.isAddingToGitignore).toBe(false)
  })
})
