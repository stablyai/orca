import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { FileContent } from './editor-panel-content-types'

const setExternalMutation = vi.fn()
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ setExternalMutation }) } }))

import {
  applyEditorFileLoadFailure,
  isPathSpecificMissingFileError
} from './editor-deleted-file-reload'

const FILE = '/repo/a.ts'
const tab: OpenFile = {
  id: FILE,
  worktreeId: 'wt',
  filePath: FILE,
  relativePath: 'a.ts',
  language: 'typescript',
  mode: 'edit',
  isDirty: false,
  lastKnownDiskSignature: 'sig'
}
const failure: FileContent = { content: '', isBinary: false, loadError: 'gone' }
// An older paired server has no existence probe; its read fails with the host's fs message.
const oldServerReadError = new Error(
  "Error invoking runtime method 'files.read': ENOENT: no such file or directory, open '/repo/a.ts'"
)

function apply(error: unknown, previous: Record<string, FileContent>, file = tab) {
  let contents = previous
  applyEditorFileLoadFailure({
    error,
    fileId: FILE,
    filePath: FILE,
    tabs: [file],
    failure,
    setFileContents: (update) => {
      contents = typeof update === 'function' ? update(contents) : update
    }
  })
  return contents
}

describe('applyEditorFileLoadFailure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps the last content and marks the tab deleted when an old server reports the file gone on catch-up', () => {
    const contents = apply(oldServerReadError, {
      [FILE]: { content: 'last seen', isBinary: false, isStale: true }
    })

    expect(contents[FILE]).toEqual({ content: 'last seen', isBinary: false, isStale: false })
    expect(setExternalMutation).toHaveBeenCalledWith(FILE, 'deleted')
  })

  it.each([
    ['a whole-request not-found', new Error('worktree not found')],
    ['another file', new Error("ENOENT: no such file or directory, open '/repo/b.ts'")],
    ['a connection failure', new Error('Remote connection dropped')]
  ])('shows the read error for %s', (_label, error) => {
    const contents = apply(error, { [FILE]: { content: 'last seen', isBinary: false } })

    expect(contents[FILE]).toBe(failure)
    expect(setExternalMutation).not.toHaveBeenCalled()
  })

  it('never claims a tab that has not read the file yet or holds unsaved edits', () => {
    expect(apply(oldServerReadError, {}, { ...tab, lastKnownDiskSignature: undefined })[FILE]).toBe(
      failure
    )
    expect(apply(oldServerReadError, {}, { ...tab, isDirty: true })[FILE]).toBe(failure)
    expect(setExternalMutation).not.toHaveBeenCalled()
  })

  it('matches a path containing an apostrophe', () => {
    expect(
      isPathSpecificMissingFileError(
        new Error("ENOENT: no such file or directory, open '/repo/it's.md'"),
        "/repo/it's.md"
      )
    ).toBe(true)
  })

  it('matches the path regardless of separator spelling', () => {
    expect(
      isPathSpecificMissingFileError(
        new Error("ENOENT: no such file or directory, open 'C:\\repo\\a.ts'"),
        'C:/repo/a.ts'
      )
    ).toBe(true)
  })
})
