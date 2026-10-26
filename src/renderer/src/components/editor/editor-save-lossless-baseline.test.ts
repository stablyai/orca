import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { createEditorStore } from './editor-autosave-controller-test-fixture'
import { createEditorSaveQueue } from './editor-save-queue'
import { GUARDED_PATH, openGuardedFile, stubGuardedDisk } from './editor-save-guarded-disk-fixture'
import { isAutosaveSuspendedForFile } from './editor-autosave'
import { __clearNonUtf8AutosavePausesForTests } from './editor-non-utf8-autosave-pause'

vi.mock('sonner', () => ({ toast: { warning: vi.fn() } }))

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.mocked(toast.warning).mockClear()
  __clearNonUtf8AutosavePausesForTests()
})

it.each([
  ['autosave', 'failed'],
  ['restart', 'failed'],
  ['user', 'not-utf8'],
  ['convert', 'written'],
  ['overwrite', 'written']
] as const)('a lossy baseline needs consent to write (%s: %s)', async (trigger, expected) => {
  const decoded = Buffer.from([0x61, 0xfe]).toString('utf8')
  const newer = Buffer.from([0x61, 0xff]).toString('utf8')
  const disk = stubGuardedDisk({ [GUARDED_PATH]: newer })
  const store = createEditorStore()
  openGuardedFile(store, { baseline: decoded, draft: decoded })
  const queue = createEditorSaveQueue(store)
  try {
    const automatic = trigger === 'autosave' || trigger === 'restart'
    expect(await queue.queueSave(store.getState().openFiles[0], decoded, trigger)).toBe(expected)
    expect(store.getState().openFiles[0]?.isDirty).toBe(expected !== 'written')
    // Why: a non-UTF-8 refusal is not a changed-on-disk conflict.
    expect(store.getState().openFiles[0]?.externalMutation).toBeUndefined()
    // Why: an explicit save asks to convert instead of pausing autosave with a notice.
    expect(isAutosaveSuspendedForFile(store.getState().openFiles[0]!)).toBe(automatic)
    expect(toast.warning).toHaveBeenCalledTimes(automatic ? 1 : 0)
    expect(disk.files.get(GUARDED_PATH)).toBe(expected === 'written' ? decoded : newer)
  } finally {
    queue.dispose()
  }
})

it('pauses autosave once for a non-UTF-8 file until a confirmed explicit save converts it', async () => {
  const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('utf8')
  const disk = stubGuardedDisk({ [GUARDED_PATH]: latin1 })
  const store = createEditorStore()
  openGuardedFile(store, { baseline: latin1, draft: `${latin1}!` })
  const queue = createEditorSaveQueue(store)
  try {
    const file = (): NonNullable<ReturnType<typeof store.getState>['openFiles'][0]> =>
      store.getState().openFiles[0]!
    expect(await queue.queueSave(file(), `${latin1}!`, 'autosave')).toBe('failed')
    expect(await queue.queueSave(file(), `${latin1}!`, 'autosave')).toBe('failed')
    expect(disk.writeFile).toHaveBeenCalledTimes(1)
    expect(toast.warning).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toast.warning).mock.calls[0]?.[0]).toContain("isn't UTF-8 text")

    expect(await queue.queueSave(file(), `${latin1}!`, 'user')).toBe('not-utf8')
    expect(disk.files.get(GUARDED_PATH)).toBe(latin1)
    expect(await queue.queueSave(file(), `${latin1}!`, 'convert')).toBe('written')
    expect(disk.files.get(GUARDED_PATH)).toBe(`${latin1}!`)
    expect(isAutosaveSuspendedForFile(file())).toBe(false)
  } finally {
    queue.dispose()
  }
})

it.each(['close', 'reload'] as const)(
  'lifts the pause on %s, so the next edit is asked about again',
  async (ending) => {
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('utf8')
    const disk = stubGuardedDisk({ [GUARDED_PATH]: latin1 })
    const store = createEditorStore()
    openGuardedFile(store, { baseline: latin1, draft: `${latin1}!` })
    const queue = createEditorSaveQueue(store)
    try {
      expect(await queue.queueSave(store.getState().openFiles[0]!, `${latin1}!`, 'autosave')).toBe(
        'failed'
      )
      if (ending === 'close') {
        // The minimal store lacks the layout state closeFile requires.
        store.setState({ openFiles: [], editorBuffers: {}, editorDrafts: {} })
      } else {
        store.getState().markFileDirty(GUARDED_PATH, false)
      }
      queue.syncAutoSave()
      openGuardedFile(store, { baseline: latin1, draft: `${latin1}?` })
      queue.syncAutoSave()
      expect(isAutosaveSuspendedForFile(store.getState().openFiles[0]!)).toBe(false)
      expect(await queue.queueSave(store.getState().openFiles[0]!, `${latin1}?`, 'autosave')).toBe(
        'failed'
      )
      expect(disk.writeFile).toHaveBeenCalledTimes(2)
      expect(toast.warning).toHaveBeenCalledTimes(2)
    } finally {
      queue.dispose()
    }
  }
)
