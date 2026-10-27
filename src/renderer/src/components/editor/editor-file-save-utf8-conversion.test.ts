import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { createEditorStore } from './editor-autosave-controller-test-fixture'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { attemptEditorFileSave, confirmEditorUtf8Conversion } from './editor-file-save-attempt'
import { GUARDED_PATH, openGuardedFile, stubGuardedDisk } from './editor-save-guarded-disk-fixture'
import { __clearNonUtf8AutosavePausesForTests } from './editor-non-utf8-autosave-pause'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'

vi.mock('sonner', () => ({ toast: { warning: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))

// "café" saved as Latin-1, decoded as UTF-8.
const LATIN1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('utf8')

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.mocked(toast.error).mockClear()
  vi.mocked(toast.warning).mockClear()
  __clearNonUtf8AutosavePausesForTests()
  __clearSelfWriteRegistryForTests()
})

function openLatin1() {
  const disk = stubGuardedDisk({ [GUARDED_PATH]: LATIN1 })
  const store = createEditorStore()
  const id = openGuardedFile(store, { baseline: LATIN1, draft: `${LATIN1}!` })
  return { disk, store, id, cleanup: attachEditorAutosaveController(store) }
}

it('asks before an explicit save rewrites a non-UTF-8 file, and leaves it alone when declined', async () => {
  const { disk, store, id, cleanup } = openLatin1()
  try {
    const confirm = vi.fn(async () => false)
    expect(await attemptEditorFileSave({ fileId: id }, confirm)).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(disk.writeFile).toHaveBeenCalledTimes(1)
    expect(disk.files.get(GUARDED_PATH)).toBe(LATIN1)
    expect(store.getState().openFiles[0]?.isDirty).toBe(true)
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalled()
  } finally {
    cleanup()
  }
})

it('writes UTF-8 once the user confirms the conversion', async () => {
  const { disk, store, id, cleanup } = openLatin1()
  try {
    const confirm = vi.fn(async () => true)
    expect(await attemptEditorFileSave({ fileId: id }, confirm)).toBe(true)
    expect(disk.files.get(GUARDED_PATH)).toBe(`${LATIN1}!`)
    expect(store.getState().openFiles[0]?.isDirty).toBe(false)
  } finally {
    cleanup()
  }
})

it('reports the refusal when no one can be asked', async () => {
  const { disk, id, cleanup } = openLatin1()
  try {
    expect(await attemptEditorFileSave({ fileId: id })).toBe(false)
    expect(disk.files.get(GUARDED_PATH)).toBe(LATIN1)
    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toBe(
      "This file isn't UTF-8 text, so it wasn't saved."
    )
  } finally {
    cleanup()
  }
})

it('words the confirmation as a lossy, destructive conversion', async () => {
  const confirm = vi.fn(async () => true)
  await confirmEditorUtf8Conversion(confirm, '/repo/notes.md')
  expect(confirm).toHaveBeenCalledWith({
    title: 'Save notes.md as UTF-8?',
    description:
      "This file isn't UTF-8 text. Saving it as UTF-8 replaces any characters that aren't valid UTF-8 with �, and the original bytes can't be recovered.",
    confirmLabel: 'Save as UTF-8',
    confirmVariant: 'destructive'
  })
})
