import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { useAppStore } from '@/store/index'
import type { TreeNode } from '../tree/file-explorer-types'
import { activateFileExplorerNode } from './useFileExplorerHandlers'

const worktree: Worktree = {
  id: 'wt-1',
  repoId: 'repo-1',
  displayName: 'wt-1',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  path: '/repo',
  head: 'HEAD',
  branch: 'main',
  isBare: false,
  isMainWorktree: false,
  hostId: 'local'
}

const fileNode: TreeNode = {
  name: 'main.ts',
  path: '/repo/main.ts',
  relativePath: 'main.ts',
  isDirectory: false,
  depth: 0,
  operationOwner: { kind: 'local' }
}

const directoryNode: TreeNode = {
  name: 'src',
  path: '/repo/src',
  relativePath: 'src',
  isDirectory: true,
  depth: 0
}

async function activate(
  node: TreeNode,
  openFileInChosenApp: (path: string, openInOrca: () => string) => boolean
): Promise<{ openFile: ReturnType<typeof vi.fn>; toggleDir: ReturnType<typeof vi.fn> }> {
  const openFile = vi.fn(() => 'opened-file-id')
  const toggleDir = vi.fn()
  useAppStore.setState({ worktreesByRepo: { 'repo-1': [worktree] } })
  await activateFileExplorerNode({
    node,
    activeWorktreeId: 'wt-1',
    runtimeEnvironmentId: null,
    openFile,
    openFileInChosenApp,
    toggleDir,
    loadDir: vi.fn(),
    statPath: vi.fn(),
    markPathAsDirectory: vi.fn(),
    setSelectedPath: vi.fn()
  })
  return { openFile, toggleDir }
}

describe('activateFileExplorerNode with an app chosen for File Explorer clicks', () => {
  it('skips the Orca editor once the app takes the file', async () => {
    const openFileInChosenApp = vi.fn().mockReturnValue(true)

    const { openFile } = await activate(fileNode, openFileInChosenApp)

    expect(openFileInChosenApp).toHaveBeenCalledWith('/repo/main.ts', expect.any(Function))
    expect(openFile).not.toHaveBeenCalled()
  })

  it('gives the app a way to open the file in the Orca editor if its launch fails', async () => {
    let openedFileId = ''
    const openFileInChosenApp = vi.fn((_path: string, openInOrca: () => string) => {
      openedFileId = openInOrca()
      return true
    })

    const { openFile } = await activate(fileNode, openFileInChosenApp)

    expect(openedFileId).toBe('opened-file-id')
    expect(openFile).toHaveBeenCalledTimes(1)
    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/repo/main.ts' }),
      expect.anything()
    )
  })

  it('opens the Orca editor when the app cannot take the file', async () => {
    const { openFile } = await activate(fileNode, vi.fn().mockReturnValue(false))

    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/repo/main.ts' }),
      expect.anything()
    )
  })

  it('still expands folders in the explorer', async () => {
    const openFileInChosenApp = vi.fn().mockReturnValue(true)

    const { toggleDir } = await activate(directoryNode, openFileInChosenApp)

    expect(toggleDir).toHaveBeenCalledWith('wt-1', '/repo/src')
    expect(openFileInChosenApp).not.toHaveBeenCalled()
  })
})
