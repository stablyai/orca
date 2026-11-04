import { afterEach, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { floatingWorkspaceId } from '../../../shared/floating-workspace-id'
import { useFloatingWorkspaceHost } from './floating-workspace-host'
import { createFloatingWorkspaceMarkdownTab } from './floating-workspace-tab-creation'

const createNote = vi.hoisted(() => vi.fn())
vi.mock('./create-untitled-markdown', () => ({
  createUntitledMarkdownFileWithTemplateSelection: createNote
}))
vi.mock('./connection-context', () => ({ getConnectionId: () => null }))

afterEach(() => {
  useFloatingWorkspaceHost.getState().selectHost(null)
  vi.clearAllMocks()
})

it('creates a local note in the local group while a remote floating host is selected', async () => {
  useFloatingWorkspaceHost.getState().selectHost('remote-host')
  const file = {
    filePath: '/scratch/untitled.md',
    relativePath: 'untitled.md',
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    mode: 'edit' as const,
    isUntitled: true
  }
  createNote.mockResolvedValue(file)
  const store = {
    activeGroupIdByWorktree: {
      [FLOATING_TERMINAL_WORKTREE_ID]: 'local-group',
      [floatingWorkspaceId('remote-host')]: 'remote-group'
    },
    openFile: vi.fn()
  }

  await createFloatingWorkspaceMarkdownTab(store, '/scratch')

  expect(createNote).toHaveBeenCalledWith('/scratch', FLOATING_TERMINAL_WORKTREE_ID, undefined, {
    kind: 'local'
  })
  expect(store.openFile).toHaveBeenCalledWith(
    { ...file, language: 'markdown' },
    { preview: false, targetGroupId: 'local-group', suppressActiveRuntimeFallback: true }
  )
  expect(useFloatingWorkspaceHost.getState().environmentId).toBeNull()
})
