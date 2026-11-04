import { describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { activateFileExplorerNode } from './useFileExplorerHandlers'

describe('activateFileExplorerNode', () => {
  it('opens a browsed file outside the workspace as a read-only user-named tab', async () => {
    const openFile = vi.fn()
    useAppStore.setState({
      worktreesByRepo: {
        'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' })]
      }
    })

    await activateFileExplorerNode({
      node: {
        name: 'notes.md',
        path: '/tmp/reference/notes.md',
        relativePath: '/tmp/reference/notes.md',
        isDirectory: false,
        depth: 0,
        operationOwner: { kind: 'local' }
      },
      activeWorktreeId: 'wt-1',
      openFile,
      toggleDir: vi.fn(),
      loadDir: vi.fn(),
      statPath: vi.fn(),
      markPathAsDirectory: vi.fn(),
      setSelectedPath: vi.fn()
    })

    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/tmp/reference/notes.md',
        relativePath: '/tmp/reference/notes.md',
        readOnly: true
      }),
      expect.anything()
    )
  })
})
