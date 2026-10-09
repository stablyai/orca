// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { makeWorktree } from '../../store/slices/worktrees-slice-test-fixtures'
import { useMarkdownDocuments } from './useMarkdownDocuments'

const mocks = vi.hoisted(() => ({ list: vi.fn(), toastError: vi.fn() }))
vi.mock('./markdown-document-list-request', () => ({
  requestSharedMarkdownDocumentList: mocks.list
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

const initialState = useAppStore.getInitialState()
const worktreeId = 'repo-1::/remote/repo'
const file: OpenFile = {
  id: 'restored',
  filePath: '/remote/repo/README.md',
  relativePath: 'README.md',
  worktreeId,
  language: 'markdown',
  isDirty: false,
  runtimeEnvironmentId: null,
  mode: 'edit'
}
const save = vi.fn(async () => true)
const document = {
  filePath: file.filePath,
  relativePath: 'README.md',
  basename: 'README.md',
  name: 'README'
}

beforeEach(() => {
  useAppStore.setState(initialState, true)
  mocks.list.mockReset().mockResolvedValue([document])
  mocks.toastError.mockClear()
  useAppStore.setState({
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: worktreeId, repoId: 'repo-1', path: '/remote/repo' })]
    }
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

function render(file: OpenFile) {
  return renderHook(({ file }) => useMarkdownDocuments(file, true, 'rich', save), {
    initialProps: { file }
  })
}

it('waits for the retained editor to take its managed workspace owner before listing', async () => {
  useAppStore.setState({
    repos: [
      {
        id: 'repo-1',
        path: '/remote/repo',
        displayName: 'repo',
        badgeColor: '#737373',
        addedAt: 1,
        executionHostId: 'runtime:env-1'
      }
    ],
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({
          id: worktreeId,
          repoId: 'repo-1',
          path: '/remote/repo',
          hostId: 'runtime:env-1',
          runtimeOwnerEnvironmentId: 'env-1'
        })
      ]
    }
  })
  const { result, rerender } = render(file)
  expect(mocks.list).not.toHaveBeenCalled()
  expect(mocks.toastError).not.toHaveBeenCalled()
  rerender({ file: { ...file, id: 'owned', runtimeEnvironmentId: 'env-1' } })
  await waitFor(() => expect(result.current.markdownDocuments).toEqual([document]))
  expect(mocks.list).toHaveBeenCalledTimes(1)
  expect(mocks.list).toHaveBeenCalledWith(
    expect.objectContaining({ settings: { activeRuntimeEnvironmentId: 'env-1' }, worktreeId }),
    '/remote/repo',
    { requireFresh: false }
  )
})

it('waits for missing ownership and resumes when the SSH catalog lands without a path change', async () => {
  const { result } = render(file)
  expect(mocks.list).not.toHaveBeenCalled()
  act(() =>
    useAppStore.setState({
      repos: [
        {
          id: 'repo-1',
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: '#737373',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ]
    })
  )
  await waitFor(() => expect(result.current.markdownDocuments).toEqual([document]))
  expect(mocks.list).toHaveBeenCalledTimes(1)
  expect(mocks.list).toHaveBeenCalledWith(
    expect.objectContaining({ connectionId: 'ssh-1' }),
    '/remote/repo',
    { requireFresh: false }
  )
})

it('uses an explicit server owner even before its desktop repository catalog is present', async () => {
  const { result } = render({ ...file, runtimeEnvironmentId: 'env-1' })
  await waitFor(() => expect(result.current.markdownDocuments).toEqual([document]))
  expect(mocks.list).toHaveBeenCalledTimes(1)
  expect(mocks.list).toHaveBeenCalledWith(
    expect.objectContaining({ settings: { activeRuntimeEnvironmentId: 'env-1' } }),
    '/remote/repo',
    { requireFresh: false }
  )
})

it('waits for ownership migration in a non-git folder workspace too', async () => {
  useAppStore.setState({
    worktreesByRepo: {},
    projectGroups: [
      {
        id: 'group-1',
        name: 'Notes',
        parentPath: '/notes',
        connectionId: null,
        executionHostId: 'runtime:env-1',
        parentGroupId: null,
        createdFrom: 'manual',
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 1,
        updatedAt: 1
      }
    ],
    folderWorkspaces: [
      {
        id: 'notes',
        projectGroupId: 'group-1',
        name: 'Notes',
        folderPath: '/notes',
        connectionId: null,
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 1,
        createdAt: 1,
        updatedAt: 1
      }
    ]
  })
  const folderFile = { ...file, worktreeId: 'folder:notes', filePath: '/notes/README.md' }
  const { result, rerender } = render(folderFile)
  expect(mocks.list).not.toHaveBeenCalled()
  rerender({ file: { ...folderFile, id: 'folder-owned', runtimeEnvironmentId: 'env-1' } })
  await waitFor(() => expect(result.current.markdownDocuments).toEqual([document]))
  expect(mocks.list).toHaveBeenCalledWith(
    expect.objectContaining({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      worktreeId: 'folder:notes'
    }),
    '/notes',
    { requireFresh: false }
  )
})
