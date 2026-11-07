import { afterEach, expect, it, vi } from 'vitest'
import type * as ConnectionOwnerModule from '@/lib/connection-owner-resolution'

// A workspace this computer owns.
vi.mock('@/lib/connection-owner-resolution', async (importOriginal) => ({
  ...(await importOriginal<typeof ConnectionOwnerModule>()),
  getConnectionIdFromState: () => null,
  getConnectionIdForFileFromState: () => null
}))
vi.mock('@/lib/user-opened-local-path', () => ({
  statUserOpenedPath: vi.fn().mockResolvedValue({ isDirectory: false, escapesWorktree: false })
}))

import { useAppStore } from '@/store'
import { editorTabFileAccess } from '@/lib/local-file-access'
import { statUserOpenedPath } from '@/lib/user-opened-local-path'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'

import { openBrowserFileSource } from './browser-file-editor-open'

const initialState = useAppStore.getInitialState()

afterEach(() => {
  useAppStore.setState(initialState, true)
  vi.clearAllMocks()
})

it('keeps user-file access when a previewed symlink escapes the workspace', async () => {
  const filePath = '/repo/docs-link/report.html'
  const openFile = vi.fn()
  useAppStore.setState({
    openFile,
    worktreesByRepo: {
      repo: [makeWorktree({ id: 'wt-1', repoId: 'repo', path: '/repo', hostId: 'local' })]
    }
  })
  vi.mocked(statUserOpenedPath).mockResolvedValueOnce({
    isDirectory: false,
    escapesWorktree: true
  })

  await openBrowserFileSource('wt-1', filePath)

  const opened = openFile.mock.calls[0][0]
  expect(opened).toMatchObject({ filePath, relativePath: filePath, mode: 'edit' })
  expect(editorTabFileAccess(useAppStore.getState(), opened)).toEqual({ kind: 'user-file' })
})
