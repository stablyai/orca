import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createFakeEditorDisk,
  createUntitledNoteStore,
  stubEditorWindowWithDisk
} from './editor-autosave-controller-test-fixture'

const FILE_PATH = '/repo/untitled.md'

afterEach(() => vi.unstubAllGlobals())

describe('untitled note close safety', () => {
  it.each(['closeFile', 'closeAllFiles'] as const)(
    '%s preserves a write that races with an old empty-file stat',
    async (action) => {
      const disk = stubEditorWindowWithDisk(createFakeEditorDisk({ [FILE_PATH]: '' }))
      disk.fs.stat.mockResolvedValue({ size: 0, isDirectory: false, mtime: 0 })
      const store = createUntitledNoteStore('untitled.md')

      if (action === 'closeFile') {
        store.getState().closeFile(FILE_PATH)
      } else {
        store.getState().closeAllFiles()
      }
      disk.files.set(FILE_PATH, 'agent finished writing')
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(disk.files.get(FILE_PATH)).toBe('agent finished writing')
      expect(disk.fs.deletePath).not.toHaveBeenCalled()
      expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)
      expect(store.getState().openFiles[0]?.filePath).toBe(FILE_PATH)
    }
  )

  it.each(['closeFile', 'closeAllFiles'] as const)(
    '%s retains and reopens a background note populated by an agent',
    async (action) => {
      const disk = stubEditorWindowWithDisk(
        createFakeEditorDisk({ [FILE_PATH]: 'agent text the tab never loaded' })
      )
      const store = createUntitledNoteStore('untitled.md')

      if (action === 'closeFile') {
        store.getState().closeFile(FILE_PATH)
      } else {
        store.getState().closeAllFiles()
      }
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(disk.files.get(FILE_PATH)).toBe('agent text the tab never loaded')
      expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)
      expect(store.getState().openFiles[0]?.filePath).toBe(FILE_PATH)
    }
  )

  it.each(['closeFile', 'closeAllFiles'] as const)(
    '%s keeps an empty note immediately reopenable',
    async (action) => {
      const disk = stubEditorWindowWithDisk(createFakeEditorDisk({ [FILE_PATH]: '' }))
      const store = createUntitledNoteStore('untitled.md')

      if (action === 'closeFile') {
        store.getState().closeFile(FILE_PATH)
      } else {
        store.getState().closeAllFiles()
      }
      expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(disk.files.get(FILE_PATH)).toBe('')
      expect(store.getState().openFiles[0]?.filePath).toBe(FILE_PATH)
    }
  )

  it('preserves normal most-recent-close order without a late cleanup callback', () => {
    stubEditorWindowWithDisk(createFakeEditorDisk({ [FILE_PATH]: '' }))
    const store = createUntitledNoteStore('untitled.md')
    store.getState().openFile({
      filePath: '/repo/readme.md',
      relativePath: 'readme.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().closeFile(FILE_PATH)
    store.getState().closeFile('/repo/readme.md')
    store.setState({ activeWorktreeId: 'wt-1' })

    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)
    expect(store.getState().activeFileId).toBe('/repo/readme.md')
    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)
    expect(store.getState().activeFileId).toBe(FILE_PATH)
  })

  it('keeps notes reopenable when close-all runs without an active worktree', () => {
    stubEditorWindowWithDisk(createFakeEditorDisk({ [FILE_PATH]: '' }))
    const store = createUntitledNoteStore('untitled.md')
    store.setState({ activeWorktreeId: null })

    store.getState().closeAllFiles()

    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)
    expect(store.getState().openFiles[0]?.filePath).toBe(FILE_PATH)
  })
})
