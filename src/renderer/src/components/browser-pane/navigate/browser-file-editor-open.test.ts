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
import { getShareableBrowserArtifactFile } from '../describe-page/browser-artifact-upload'
import {
  canOpenBrowserFileInWorkspaceEditor,
  openBrowserFileSource
} from './browser-file-editor-open'

const PATH = '/Users/me/orca/chat-scratch/0123456789abcdef0123456789abcdef/usage.html'
const initialState = useAppStore.getInitialState()

afterEach(() => {
  useAppStore.setState(initialState, true)
  vi.clearAllMocks()
})

it("opens a local chat visual's page as an editable source tab, read and saved in place", async () => {
  const openFile = vi.fn()
  useAppStore.setState({ openFile })
  expect(getShareableBrowserArtifactFile(`file://${encodeURI(PATH)}`)?.filePath).toBe(PATH)
  expect(canOpenBrowserFileInWorkspaceEditor(useAppStore.getState(), 'wt-1')).toBe(true)

  await openBrowserFileSource('wt-1', PATH)
  const opened = openFile.mock.calls[0][0]
  expect(opened).toMatchObject({ filePath: PATH, relativePath: PATH, mode: 'edit' })
  // What its editor reads and saves with: the user-named file itself, outside any project.
  expect(editorTabFileAccess(useAppStore.getState(), opened)).toEqual({ kind: 'user-file' })
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
