// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarkdownDocument } from '../../../../shared/types'
import { MarkdownDocumentListingCapacityError } from '../../../../shared/markdown-document-listing-limits'
import type { OpenFile } from '@/store/slices/editor'
import { useMarkdownDocuments } from './useMarkdownDocuments'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  openFile: vi.fn(),
  openMarkdownPreview: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/runtime/runtime-file-client', () => ({ statRuntimePath: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  settingsForRuntimeOwner: () => ({ activeRuntimeEnvironmentId: null })
}))
vi.mock('./markdown-document-list-request', () => ({
  requestSharedMarkdownDocumentList: mocks.list
}))
vi.mock('./markdown-document-worktree-path-selector', () => ({
  selectMarkdownDocumentWorktreePath: (_state: unknown, worktreeId: string) => `/repo/${worktreeId}`
}))
vi.mock('@/store', () => {
  const state = {
    settings: {},
    openFile: mocks.openFile,
    openMarkdownPreview: mocks.openMarkdownPreview
  }
  const useAppStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state }
  )
  return { useAppStore }
})

function file(worktreeId: string): OpenFile {
  return {
    id: `/repo/${worktreeId}/README.md`,
    filePath: `/repo/${worktreeId}/README.md`,
    relativePath: 'README.md',
    worktreeId,
    language: 'markdown',
    isDirty: false,
    mode: 'edit'
  }
}

function deferred<T>(): {
  promise: Promise<T>
  reject: (error: Error) => void
  resolve: (value: T) => void
} {
  let reject!: (error: Error) => void
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('useMarkdownDocuments', () => {
  it('does not toast when a superseded worktree scan later exceeds capacity', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = deferred<MarkdownDocument[]>()
    const second = deferred<MarkdownDocument[]>()
    mocks.list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    const hook = renderHook(
      ({ activeFile }) => useMarkdownDocuments(activeFile, true, 'source', vi.fn()),
      { initialProps: { activeFile: file('first') } }
    )
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1))

    hook.rerender({ activeFile: file('second') })
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))

    await act(async () => {
      first.reject(new MarkdownDocumentListingCapacityError())
      second.resolve([])
      await Promise.allSettled([first.promise, second.promise])
    })

    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})
