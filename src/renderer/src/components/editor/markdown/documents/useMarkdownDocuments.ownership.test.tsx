// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { makeWorktree } from '../../../../store/slices/worktrees-slice-test-fixtures'
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
