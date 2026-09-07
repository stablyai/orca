import { describe, expect, it, vi } from 'vitest'
import type { FsChangeEvent } from '../../../../shared/filesystem-entry-types'
import type { DirCache } from './file-explorer-types'
import { processFileExplorerFsPayload } from './file-explorer-watch-reconcile'

const DRIVE_ROOTS = [
  { label: 'backslash', root: 'C:\\', child: (name: string) => `c:\\${name}` },
  { label: 'slash', root: 'C:/', child: (name: string) => `c:/${name}` }
]

function processRootEvent(root: string, event: FsChangeEvent): ReturnType<typeof vi.fn> {
  const refreshDir = vi.fn()
  const rootCache: DirCache = {
    children: [],
    operationOwner: { kind: 'local' }
  }

  processFileExplorerFsPayload({
    payload: { worktreePath: root, events: [event] },
    currentWorktreePath: root,
    worktreeId: 'folder::drive-root',
    cache: { [root]: rootCache },
    expanded: new Set(),
    setDirCache: vi.fn(),
    setSelectedPath: vi.fn(),
    refreshDir,
    refreshTree: vi.fn()
  })

  return refreshDir
}

describe('Windows drive-root watcher reconciliation', () => {
  it.each(DRIVE_ROOTS)(
    'refreshes a $label drive root for an update-only create',
    ({ root, child }) => {
      const refreshDir = processRootEvent(root, {
        kind: 'update',
        absolutePath: child('new-file.txt'),
        isDirectory: false
      })

      expect(refreshDir).toHaveBeenCalledOnce()
      expect(refreshDir).toHaveBeenCalledWith(root)
    }
  )

  it.each(DRIVE_ROOTS)('refreshes a $label drive root after a delete', ({ root, child }) => {
    const refreshDir = processRootEvent(root, {
      kind: 'delete',
      absolutePath: child('removed-file.txt')
    })

    expect(refreshDir).toHaveBeenCalledOnce()
    expect(refreshDir).toHaveBeenCalledWith(root)
  })

  it.each(DRIVE_ROOTS)('refreshes a $label drive root once after a rename', ({ root, child }) => {
    const refreshDir = processRootEvent(root, {
      kind: 'rename',
      oldAbsolutePath: child('old-file.txt'),
      absolutePath: child('new-file.txt'),
      isDirectory: false
    })

    expect(refreshDir).toHaveBeenCalledOnce()
    expect(refreshDir).toHaveBeenCalledWith(root)
  })
})
