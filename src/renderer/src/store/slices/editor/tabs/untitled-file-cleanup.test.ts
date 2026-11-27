// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDiskBaselineSignature } from '../../../../../../shared/file-write/disk-baseline-signature'
import type { FileDeleteIfUnchangedResult } from '../../../../../../shared/file-write/file-write-disk-precondition'
import type { AppState } from '@/store/types'
import { deleteUntouchedUntitledFile } from '@/store/slices/editor/tabs/untitled-file-cleanup'

const deleteRuntimeRelativePathIfUnchanged = vi.fn()

vi.mock('@/runtime/files/mutations/runtime-file-mutation-client', () => ({
  deleteRuntimeRelativePathIfUnchanged: (...args: unknown[]) =>
    deleteRuntimeRelativePathIfUnchanged(...args)
}))

vi.mock('@/lib/editor/file-operations/editor-file-operation-owner', () => ({
  getEditorFileOperationContext: () => ({ worktreeId: 'repo::/repo', worktreePath: '/repo' })
}))

vi.mock('@/lib/workspace/ownership/worktree-runtime-owner-index', () => ({
  findFirstIndexedWorktree: () => ({ path: '/repo' })
}))

vi.mock('@/store/workspaces/catalog/workspace-record-fields', () => ({
  selectWorktreesByRepo: () => ({})
}))

const note = {
  id: 'untitled-1',
  filePath: '/repo/untitled.md',
  relativePath: 'untitled.md',
  worktreeId: 'repo::/repo',
  language: 'markdown',
  isUntitled: true,
  isDirty: false,
  mode: 'edit' as const
}

function cleanup(result: FileDeleteIfUnchangedResult | null): {
  remembered: (typeof note)[]
} {
  const remembered: (typeof note)[] = []
  deleteRuntimeRelativePathIfUnchanged.mockResolvedValue(result)
  // The tab is already closed: only an unrelated tab would remain in the real store.
  deleteUntouchedUntitledFile(
    () => ({ openFiles: [] }) as unknown as AppState,
    note,
    (file) => remembered.push(file as typeof note)
  )
  return { remembered }
}

describe('closing an untouched untitled note whose file gained content meanwhile', () => {
  beforeEach(() => {
    deleteRuntimeRelativePathIfUnchanged.mockReset()
  })

  it('pins deletion to the empty bytes it was created with, in one host request', async () => {
    cleanup({ ok: true })
    await vi.waitFor(() => expect(deleteRuntimeRelativePathIfUnchanged).toHaveBeenCalled())
    const [, relativePath, precondition] = deleteRuntimeRelativePathIfUnchanged.mock.calls[0]
    expect(relativePath).toBe('untitled.md')
    expect(precondition).toEqual({
      expectedSignature: getDiskBaselineSignature(''),
      requireLosslessUtf8: true
    })
  })

  it('keeps the note in the reopen history when the host refuses a file that has content', async () => {
    const { remembered } = cleanup({ ok: false, diskConflict: 'changed' })
    await vi.waitFor(() => expect(remembered).toHaveLength(1))
    expect(remembered[0]).toBe(note)
  })

  it('leaves the reopen history alone once the empty placeholder was deleted', async () => {
    const { remembered } = cleanup({ ok: true })
    await vi.waitFor(() => expect(deleteRuntimeRelativePathIfUnchanged).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(remembered).toHaveLength(0)
  })

  it('does not delete through an older host that cannot check and delete together', async () => {
    const { remembered } = cleanup(null)
    await vi.waitFor(() => expect(deleteRuntimeRelativePathIfUnchanged).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(remembered).toHaveLength(0)
  })
})
