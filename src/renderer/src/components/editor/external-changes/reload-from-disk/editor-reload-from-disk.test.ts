import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { FileContent } from '../../loading/editor-panel-content-types'
import { getDiskBaselineSignature } from '../../../../../../shared/file-write/disk-baseline-signature'

const mocks = vi.hoisted(() => {
  const openFiles: OpenFile[] = []
  const flushResults: boolean[] = []
  return {
    state: { openFiles, setExternalMutation: vi.fn() },
    read: vi.fn(),
    notify: vi.fn(),
    markChanged: vi.fn(),
    selfWrite: vi.fn(),
    marks: { count: 0 },
    framesFlushed: true,
    flushResults
  }
})

vi.mock('@/store/index', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/runtime/files/reads/runtime-file-read-client', () => ({
  readRuntimeFileContent: mocks.read
}))
vi.mock('@/lib/workspace/ownership/connection-context', () => ({
  getConnectionIdForFile: () => null
}))
vi.mock('@/lib/files/access/local-file-access', () => ({
  editorTabFileAccess: () => undefined,
  isClientLocalReadOnlyTab: () => false
}))
vi.mock('@/lib/editor/file-operations/editor-file-operation-owner', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  acquireEditorFileOperation: () => ({
    context: { target: { kind: 'local' } },
    assertCurrent: () => {}
  })
}))
vi.mock('@/lib/workspace/ownership/worktree-runtime-owner-index', () => ({
  findFirstIndexedWorktree: () => ({ path: '/repo' })
}))
vi.mock('@/store/workspaces/catalog/workspace-record-fields', () => ({
  selectWorktreesByRepo: () => ({})
}))
vi.mock('../../autosave/editor-autosave', () => ({ notifyEditorExternalFileChange: mocks.notify }))
vi.mock('../editor-changed-on-disk-mark', () => ({ markFileChangedOnDisk: mocks.markChanged }))
vi.mock('../editor-conflict-report-count', () => ({
  noteEditorConflictReport: () => {},
  watchEditorConflictReports: () => {
    const start = mocks.marks.count
    return { reported: () => mocks.marks.count !== start, stop: () => {} }
  }
}))
vi.mock('../editor-self-write-registry', () => ({ getRecentSelfWrite: mocks.selfWrite }))
// Each tab is its own model in these tests; sibling rules are covered by the save-queue suites.
vi.mock('../../save/queue/editor-save-disk-precondition', () => ({
  editorModelSiblingTabs: (_state: unknown, file: OpenFile) => [
    mocks.state.openFiles.find((tab) => tab.id === file.id) ?? file
  ],
  isEditorModelDirty: (_state: unknown, file: OpenFile) =>
    mocks.state.openFiles.find((tab) => tab.id === file.id)?.isDirty === true
}))
vi.mock('../../save/queue/editor-save-rebaseline', () => ({
  setModelExternalMutation: (state: typeof mocks.state, id: string, value: unknown) =>
    state.setExternalMutation(id, value)
}))

vi.mock('../../save/flush/editor-pending-flush', () => ({
  flushEditorFrames: async () => mocks.flushResults.shift() ?? mocks.framesFlushed
}))

const { reloadEditorFileFromDisk } = await import('./editor-reload-from-disk')

const BASE = 'base text'
const shownText: FileContent = { content: BASE, isBinary: false }

function tab(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: '/repo/a.md',
    filePath: '/repo/a.md',
    relativePath: 'a.md',
    worktreeId: 'wt',
    language: 'markdown',
    isDirty: false,
    mode: 'edit',
    lastKnownDiskSignature: getDiskBaselineSignature(BASE),
    ...overrides
  }
}

function open(...tabs: OpenFile[]): void {
  mocks.state.openFiles = tabs
}

describe('reloadEditorFileFromDisk', () => {
  beforeEach(() => {
    mocks.read.mockReset()
    mocks.notify.mockReset()
    mocks.markChanged.mockReset()
    mocks.selfWrite.mockReset().mockReturnValue(null)
    mocks.state.setExternalMutation.mockReset()
    mocks.framesFlushed = true
    mocks.flushResults = []
  })

  it('reports unchanged and reloads nothing when the disk matches the clean baseline', async () => {
    open(tab())
    mocks.read.mockResolvedValue({ content: BASE, isBinary: false })
    expect(await reloadEditorFileFromDisk('/repo/a.md', shownText)).toEqual({ kind: 'unchanged' })
    expect(mocks.notify).not.toHaveBeenCalled()
    expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({ wakeWslDistro: true }))
  })

  it('reloads a clean tab through the watcher path when the disk differs', async () => {
    open(tab())
    mocks.read.mockResolvedValue({ content: 'agent write', isBinary: false })
    expect(await reloadEditorFileFromDisk('/repo/a.md', shownText)).toEqual({ kind: 'reloaded' })
    expect(mocks.notify).toHaveBeenCalledTimes(1)
    const target = mocks.notify.mock.calls[0][0]
    expect(
      target.indexedOpenFiles.matches([tab(), tab({ id: 'other', filePath: '/repo/b.md' })])
    ).toHaveLength(1)
  })

  it('raises the banner, never reloading, when a dirty model meets a different disk', async () => {
    open(tab({ isDirty: true }))
    mocks.read.mockResolvedValue({ content: 'agent write', isBinary: false })
    expect(await reloadEditorFileFromDisk('/repo/a.md', shownText)).toEqual({
      kind: 'conflict-shown'
    })
    expect(mocks.markChanged).toHaveBeenCalledTimes(1)
    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it('always reads before deciding for a dirty tab, even with nothing comparable shown', async () => {
    open(tab({ isDirty: true }))
    mocks.read.mockResolvedValue({ content: BASE, isBinary: false })
    expect(await reloadEditorFileFromDisk('/repo/a.md', undefined)).toEqual({ kind: 'unchanged' })
    expect(mocks.notify).not.toHaveBeenCalled()
    expect(mocks.markChanged).not.toHaveBeenCalled()
  })

  it('treats the echo of our own save as unchanged without clearing a conflict', async () => {
    open(tab({ isDirty: true, externalMutation: 'changed' }))
    mocks.read.mockResolvedValue({ content: 'my save', isBinary: false })
    mocks.selfWrite.mockReturnValue({ content: 'my save' })
    expect(await reloadEditorFileFromDisk('/repo/a.md', shownText)).toEqual({ kind: 'unchanged' })
    expect(mocks.state.setExternalMutation).not.toHaveBeenCalled()
    expect(mocks.markChanged).not.toHaveBeenCalled()
  })

  it('clears a conflict when the disk went back to the version the edits were typed over', async () => {
    open(tab({ isDirty: true, externalMutation: 'changed' }))
    mocks.read.mockResolvedValue({ content: BASE, isBinary: false })
    expect(await reloadEditorFileFromDisk('/repo/a.md', shownText)).toEqual({ kind: 'unchanged' })
    expect(mocks.state.setExternalMutation).toHaveBeenCalledWith('/repo/a.md', null)
  })

  it('keeps a conflict that was raised while its read was in flight', async () => {
    open(tab({ isDirty: true }))
    mocks.read.mockImplementation(async () => {
      // A watcher event marks the model changed after these bytes were read.
      open(tab({ isDirty: true, externalMutation: 'changed' }))
      return { content: BASE, isBinary: false }
    })
    expect(await reloadEditorFileFromDisk('/repo/a.md', shownText)).toEqual({
      kind: 'conflict-shown'
    })
    expect(mocks.state.setExternalMutation).not.toHaveBeenCalled()
  })

  it('keeps an existing conflict when another change is reported during the read', async () => {
    open(tab({ isDirty: true, externalMutation: 'changed' }))
    mocks.read.mockImplementation(async () => {
      mocks.marks.count += 1
      return { content: BASE, isBinary: false }
    })
    expect(await reloadEditorFileFromDisk('/repo/a.md', shownText)).toEqual({
      kind: 'conflict-shown'
    })
    expect(mocks.state.setExternalMutation).not.toHaveBeenCalled()
  })

  it('reads again when a save moves the baseline during the read', async () => {
    open(tab({ isDirty: true }))
    const saved = getDiskBaselineSignature('saved text')
    mocks.read
      .mockImplementationOnce(async () => {
        open(tab({ isDirty: true, lastKnownDiskSignature: saved }))
        return { content: BASE, isBinary: false }
      })
      .mockResolvedValueOnce({ content: 'saved text', isBinary: false })
    expect(await reloadEditorFileFromDisk('/repo/a.md', shownText)).toEqual({ kind: 'unchanged' })
    expect(mocks.read).toHaveBeenCalledTimes(2)
    expect(mocks.markChanged).not.toHaveBeenCalled()
  })

  it('never reloads a same-path tab on another host', async () => {
    open(tab())
    mocks.read.mockResolvedValue({ content: 'agent write', isBinary: false })
    await reloadEditorFileFromDisk('/repo/a.md', shownText)
    const target = mocks.notify.mock.calls[0][0]
    expect(
      target.indexedOpenFiles.matches([tab({ id: 'ssh', externalSshTargetId: 'host-1' })])
    ).toHaveLength(0)
  })

  it('refuses to guess for a dirty tab without a baseline', async () => {
    open(tab({ isDirty: true, lastKnownDiskSignature: undefined }))
    expect(await reloadEditorFileFromDisk('/repo/a.md', shownText)).toEqual({
      kind: 'cannot-check-dirty'
    })
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('decides a Markdown preview on its dirty source tab and reports where the banner went', async () => {
    const source = tab({ isDirty: true })
    const preview = tab({
      id: 'preview',
      mode: 'markdown-preview',
      markdownPreviewSourceFileId: source.id
    })
    open(source, preview)
    mocks.read.mockResolvedValue({ content: 'agent write', isBinary: false })
    const outcome = await reloadEditorFileFromDisk('preview', shownText)
    expect(outcome).toMatchObject({ kind: 'conflict-elsewhere', sourceTab: { id: source.id } })
    expect(mocks.markChanged).toHaveBeenCalledWith(
      mocks.state,
      expect.objectContaining({ id: source.id }),
      expect.anything()
    )
  })

  it('skips the decision read for content it cannot compare', async () => {
    for (const shown of [
      undefined,
      { content: '', isBinary: true },
      { content: BASE, isBinary: false, isStale: true }
    ]) {
      open(tab())
      mocks.notify.mockReset()
      expect(await reloadEditorFileFromDisk('/repo/a.md', shown)).toEqual({ kind: 'reloaded' })
      expect(mocks.notify).toHaveBeenCalledTimes(1)
    }
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('retries a failed load through the panel so a stopped WSL distro can start', async () => {
    open(tab())
    const retryFailedLoad = vi.fn()
    await reloadEditorFileFromDisk(
      '/repo/a.md',
      { content: '', isBinary: false, loadError: 'boom' },
      { retryFailedLoad }
    )
    expect(retryFailedLoad).toHaveBeenCalledTimes(1)
    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it('leaves a background check silent for anything but comparable text', async () => {
    open(tab())
    expect(
      await reloadEditorFileFromDisk(
        '/repo/a.md',
        { content: '', isBinary: true },
        { background: true }
      )
    ).toEqual({ kind: 'skipped' })
    expect(mocks.notify).not.toHaveBeenCalled()
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('lets the loader turn a missing file into the deleted state', async () => {
    open(tab())
    mocks.read.mockRejectedValue(new Error("ENOENT: no such file or directory, open '/repo/a.md'"))
    expect(await reloadEditorFileFromDisk('/repo/a.md', shownText)).toEqual({ kind: 'deleted' })
    expect(mocks.notify).toHaveBeenCalledTimes(1)
  })

  it('keeps an edit made during a failing read of a deleted file', async () => {
    open(tab())
    mocks.read.mockImplementation(async () => {
      open(tab({ isDirty: true }))
      throw new Error("ENOENT: no such file or directory, open '/repo/a.md'")
    })
    expect(await reloadEditorFileFromDisk('/repo/a.md', shownText)).toMatchObject({
      kind: 'read-failed'
    })
    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it('reports other read failures without touching the tab', async () => {
    open(tab())
    const error = new Error('connection lost')
    mocks.read.mockRejectedValue(error)
    expect(await reloadEditorFileFromDisk('/repo/a.md', shownText)).toEqual({
      kind: 'read-failed',
      error
    })
    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it('stays quiet when a preview source tab closes during a failing read', async () => {
    const source = tab({ isDirty: true })
    const preview = tab({
      id: 'preview',
      mode: 'markdown-preview',
      markdownPreviewSourceFileId: source.id
    })
    open(source, preview)
    mocks.read.mockImplementation(async () => {
      open(preview)
      throw new Error('owner changed')
    })
    expect(await reloadEditorFileFromDisk('preview', shownText)).toEqual({ kind: 'skipped' })
  })

  it('drops the result when the tab was closed during the read', async () => {
    open(tab())
    mocks.read.mockImplementation(async () => {
      open()
      return { content: 'agent write', isBinary: false }
    })
    expect(await reloadEditorFileFromDisk('/repo/a.md', shownText)).toEqual({ kind: 'skipped' })
    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it('replaces nothing while a custom editor frame keeps edits back', async () => {
    open(tab())
    mocks.framesFlushed = false
    expect(await reloadEditorFileFromDisk('/repo/a.md', shownText)).toEqual({
      kind: 'cannot-check-dirty'
    })
    expect(await reloadEditorFileFromDisk('/repo/a.md', shownText, { background: true })).toEqual({
      kind: 'skipped'
    })
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it('replaces nothing when a custom editor frame keeps an edit made during the read', async () => {
    open(tab())
    // First flush (before the read) succeeds; the one after the read finds an edit it can't hand over.
    mocks.flushResults = [true, false]
    mocks.read.mockResolvedValue({ content: 'agent write', isBinary: false })
    expect(await reloadEditorFileFromDisk('/repo/a.md', shownText)).toEqual({
      kind: 'cannot-check-dirty'
    })
    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it('keeps a frame edit made while a dirty read turned clean', async () => {
    open(tab({ isDirty: true }))
    // Before the read the frame hands over; afterwards it holds an edit it can't hand over.
    mocks.flushResults = [true, false]
    mocks.read.mockImplementation(async () => {
      // A save settles during the read, leaving the model clean but the disk older than the frame.
      open(tab())
      return { content: 'agent write', isBinary: false }
    })
    expect(await reloadEditorFileFromDisk('/repo/a.md', shownText)).toEqual({
      kind: 'cannot-check-dirty'
    })
    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it('decides nothing from a clean read that a save overtook', async () => {
    open(tab())
    mocks.read.mockImplementation(async () => {
      open(tab({ lastKnownDiskSignature: getDiskBaselineSignature('saved text') }))
      return { content: BASE, isBinary: false }
    })
    expect(await reloadEditorFileFromDisk('/repo/a.md', shownText)).toEqual({ kind: 'skipped' })
    expect(mocks.notify).not.toHaveBeenCalled()
    expect(mocks.markChanged).not.toHaveBeenCalled()
  })

  it('drops a silent read failure that a click overtook', async () => {
    open(tab())
    mocks.read.mockRejectedValue(new Error("ENOENT: no such file or directory, open '/repo/a.md'"))
    expect(
      await reloadEditorFileFromDisk('/repo/a.md', shownText, {
        background: true,
        isSuperseded: () => true
      })
    ).toEqual({ kind: 'skipped' })
    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it('drops a silent read that a click overtook', async () => {
    open(tab())
    mocks.read.mockResolvedValue({ content: 'agent write', isBinary: false })
    expect(
      await reloadEditorFileFromDisk('/repo/a.md', shownText, {
        background: true,
        isSuperseded: () => true
      })
    ).toEqual({ kind: 'skipped' })
    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it('ignores ineligible tabs', async () => {
    for (const file of [
      tab({ mode: 'diff' }),
      tab({ isUntitled: true }),
      tab({ externalMutation: 'deleted' }),
      tab({ externalMutation: 'renamed' })
    ]) {
      open(file)
      expect(await reloadEditorFileFromDisk(file.id, shownText)).toEqual({ kind: 'skipped' })
    }
    expect(mocks.read).not.toHaveBeenCalled()
  })
})
