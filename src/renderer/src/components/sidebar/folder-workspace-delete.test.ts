import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import { deleteFolderWorkspaceUnlessUnsaved } from './folder-workspace-delete'
import { projectRemovalTargets } from './removal-unsaved-files'

const mocks = vi.hoisted(() => ({ toastError: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/components/editor/editor-model-owner', () => ({
  resolveEditorModelOwner: () => ({ environmentId: null, hostId: 'local' }),
  getEditorModelOwnerKey: () => ''
}))

function state(dirty: boolean): AppState {
  const openFiles = dirty
    ? [
        {
          id: 'f',
          filePath: '/notes/a.md',
          relativePath: 'a.md',
          worktreeId: 'folder:notes',
          language: 'markdown',
          isDirty: true,
          mode: 'edit'
        }
      ]
    : []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the delete and the unsaved check read only these fields.
  return {
    openFiles,
    editorDrafts: {},
    editorBufferIdOf: { f: 'f' },
    editorBufferViews: { f: ['f'] },
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    projectGroups: [],
    folderWorkspaces: [{ id: 'notes', name: 'Notes' }],
    activeWorktreeId: 'folder:notes',
    activeWorkspaceExecutionHostId: null,
    deleteFolderWorkspace: vi.fn().mockResolvedValue(true),
    setActiveWorktree: vi.fn()
  } as unknown as AppState
}

describe('deleteFolderWorkspaceUnlessUnsaved', () => {
  beforeEach(() => {
    mocks.toastError.mockClear()
  })

  it('refuses while the workspace holds unsaved editor text, and says so', () => {
    const s = state(true)
    expect(deleteFolderWorkspaceUnlessUnsaved(() => s, 'notes')).toBeNull()
    expect(s.deleteFolderWorkspace).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('Save or close 1 unsaved file in Notes first')
  })

  it('deletes without asking when a same-id folder on another host keeps the tabs open', async () => {
    const s = state(true)
    Object.assign(s, {
      folderWorkspaces: [
        { id: 'notes', name: 'Notes', executionHostId: 'local' },
        { id: 'notes', name: 'Notes', executionHostId: 'ssh:box' }
      ]
    })
    await expect(deleteFolderWorkspaceUnlessUnsaved(() => s, 'notes', 'ssh:box')).resolves.toBe(
      true
    )
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('deletes and clears the selection when it was the active workspace', async () => {
    const s = state(false)
    await expect(deleteFolderWorkspaceUnlessUnsaved(() => s, 'notes')).resolves.toBe(true)
    expect(s.deleteFolderWorkspace).toHaveBeenCalledWith('notes', undefined)
    expect(s.setActiveWorktree).toHaveBeenCalledWith(null)
  })
})

describe('projectRemovalTargets', () => {
  it('names every row of the project on the removed host', () => {
    const rows = {
      detectedWorktreesByRepo: {
        repo: { worktrees: [{ id: 'repo::/detected', hostId: 'ssh:box' }] }
      },
      worktreesByRepo: {
        repo: [
          { id: 'repo::/a', hostId: 'ssh:box' },
          { id: 'repo::/b', hostId: 'local' },
          { id: 'repo::/c' }
        ]
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only id and hostId are read.
    const s = rows as unknown as Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo'>
    expect(projectRemovalTargets(s, [{ repoId: 'repo', hostId: 'ssh:box' }])).toEqual([
      { id: 'repo::/a', hostId: 'ssh:box' },
      { id: 'repo::/detected', hostId: 'ssh:box' }
    ])
  })
})
