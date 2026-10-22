import { expect, it, vi } from 'vitest'
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
import { getShareableBrowserArtifactFile } from '../describe-page/browser-artifact-upload'
import {
  canOpenBrowserFileInWorkspaceEditor,
  openBrowserFileSource
} from './browser-file-editor-open'

const PATH = '/Users/me/orca/chat-scratch/0123456789abcdef0123456789abcdef/usage.html'

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
