import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'
import type { AppState } from '@/store'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import {
  ORCA_EDITOR_FILE_SAVED_EVENT,
  requestEditorFileSave,
  type EditorFileSavedDetail
} from './editor-autosave'
import { createEditorStore, stubEditorWindow } from './editor-autosave-controller-test-fixture'
import {
  __clearSelfWriteRegistryForTests,
  getRecentSelfWrite,
  hasRecentSelfWrite,
  isDiskContentExpectedBySelfWrite
} from './editor-self-write-registry'

const UNFORMATTED = 'const a=1'
const FORMATTED = 'const a = 1\n'

let store: StoreApi<AppState>
let detach: () => void
let formatOnSave: ReturnType<typeof vi.fn>
let readFile: ReturnType<typeof vi.fn>
let writeFile: ReturnType<typeof vi.fn>

const FILE_ID = '/repo/src/a.ts'

function openEditableFile(): void {
  store.getState().openFile({
    filePath: FILE_ID,
    relativePath: 'src/a.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    mode: 'edit'
  } as never)
}

function savedContents(): string[] {
  return savedEvents
}

let savedEvents: string[] = []

beforeEach(() => {
  savedEvents = []
  formatOnSave = vi.fn().mockResolvedValue({ status: 'completed' })
  readFile = vi.fn().mockResolvedValue({ content: FORMATTED })
  writeFile = stubEditorWindow({ formatOnSave, readFile })
  store = createEditorStore()
  store.setState({
    repos: [
      {
        id: 'repo-1',
        formatOnSave: { enabled: true, command: 'prettier --write ${file}', include: ['**/*.ts'] }
      }
    ]
  } as never)
  openEditableFile()
  detach = attachEditorAutosaveController(store)
  window.addEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, ((
    event: CustomEvent<EditorFileSavedDetail>
  ) => {
    savedEvents.push(event.detail.content)
  }) as EventListener)
})

afterEach(() => {
  detach()
  __clearSelfWriteRegistryForTests()
  vi.unstubAllGlobals()
})

describe('format on save through the editor save queue', () => {
  it('adopts the formatted file into the buffer after the write', async () => {
    store.getState().setEditorDraft(FILE_ID, UNFORMATTED)
    await requestEditorFileSave({ fileId: FILE_ID })

    expect(writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: FILE_ID, content: UNFORMATTED })
    )
    expect(formatOnSave).toHaveBeenCalledWith({
      repoId: 'repo-1',
      worktreePath: '/repo',
      filePath: FILE_ID
    })
    expect(savedContents()).toEqual([FORMATTED])
    expect(store.getState().openFiles.find((file) => file.id === FILE_ID)?.isDirty).toBe(false)
  })

  it('suppresses the formatter write as an external change', async () => {
    store.getState().setEditorDraft(FILE_ID, UNFORMATTED)
    await requestEditorFileSave({ fileId: FILE_ID })

    // Why: without a re-stamp the watcher reports Orca's own formatting as a
    // changed-on-disk conflict on the very next event.
    expect(hasRecentSelfWrite(FILE_ID, undefined)).toBe(true)
  })

  it('keeps the typed buffer when the user edits while the formatter runs', async () => {
    let releaseFormat: ((value: { status: string }) => void) | undefined
    let markFormatStarted: (() => void) | undefined
    const formatStarted = new Promise<void>((resolve) => {
      markFormatStarted = resolve
    })
    formatOnSave.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFormat = resolve as (value: { status: string }) => void
          markFormatStarted?.()
        })
    )

    store.getState().setEditorDraft(FILE_ID, UNFORMATTED)
    const save = requestEditorFileSave({ fileId: FILE_ID })
    await formatStarted

    store.getState().setEditorDraft(FILE_ID, `${UNFORMATTED}\nconst b=2`)
    releaseFormat?.({ status: 'completed' })
    await save

    // Why: the event reports what landed on disk, which is the formatted text.
    // The user's newer keystrokes stay in the draft and still win in the editor.
    expect(savedContents()).toEqual([FORMATTED])
    expect(store.getState().editorDrafts[FILE_ID]).toBe(`${UNFORMATTED}\nconst b=2`)
    expect(store.getState().openFiles.find((file) => file.id === FILE_ID)?.isDirty).toBe(true)
  })

  it('leaves the saved content alone when the formatter changes nothing', async () => {
    readFile.mockResolvedValue({ content: UNFORMATTED })
    store.getState().setEditorDraft(FILE_ID, UNFORMATTED)
    await requestEditorFileSave({ fileId: FILE_ID })

    expect(savedContents()).toEqual([UNFORMATTED])
  })

  it('still reports the save as successful when the formatter fails', async () => {
    formatOnSave.mockResolvedValue({ status: 'failed', message: 'SyntaxError' })
    readFile.mockResolvedValue({ content: UNFORMATTED })
    store.getState().setEditorDraft(FILE_ID, UNFORMATTED)

    await expect(requestEditorFileSave({ fileId: FILE_ID })).resolves.toBeUndefined()
    expect(savedContents()).toEqual([UNFORMATTED])
  })

  it('adopts what a failing formatter wrote before it exited', async () => {
    formatOnSave.mockResolvedValue({ status: 'failed', message: 'lint step failed' })
    store.getState().setEditorDraft(FILE_ID, UNFORMATTED)

    await requestEditorFileSave({ fileId: FILE_ID })
    expect(savedContents()).toEqual([FORMATTED])
  })

  it('treats the formatter echo as its own while the formatter is still running', async () => {
    let releaseFormat: ((value: { status: string }) => void) | undefined
    let markFormatStarted: (() => void) | undefined
    const formatStarted = new Promise<void>((resolve) => {
      markFormatStarted = resolve
    })
    formatOnSave.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFormat = resolve as (value: { status: string }) => void
          markFormatStarted?.()
        })
    )

    store.getState().setEditorDraft(FILE_ID, UNFORMATTED)
    const save = requestEditorFileSave({ fileId: FILE_ID })
    await formatStarted

    // Why: the formatter's bytes are unknown until it exits, so events are held rather than judged.
    expect(getRecentSelfWrite(FILE_ID, undefined)).toEqual({
      content: null,
      formatterPending: true
    })
    expect(isDiskContentExpectedBySelfWrite(FILE_ID, undefined, FORMATTED)).toBe(false)

    releaseFormat?.({ status: 'completed' })
    await save
    expect(getRecentSelfWrite(FILE_ID, undefined)).toEqual({ content: FORMATTED })
  })

  it('does not install the accept-anything stamp when the repo has no formatter configured', async () => {
    store.setState({ repos: [{ id: 'repo-1' }] } as never)
    let pendingSeenDuringFormat: boolean | undefined
    formatOnSave.mockImplementation(async () => {
      pendingSeenDuringFormat = getRecentSelfWrite(FILE_ID, undefined)?.formatterPending
      return { status: 'skipped', reason: 'not-configured' }
    })
    store.getState().setEditorDraft(FILE_ID, UNFORMATTED)
    await requestEditorFileSave({ fileId: FILE_ID })

    // Why: a genuine external write during the IPC round trip must still be detectable.
    expect(pendingSeenDuringFormat).toBeUndefined()
    expect(getRecentSelfWrite(FILE_ID, undefined)).toEqual({ content: UNFORMATTED })
  })

  it('does not install the accept-anything stamp for a file the include list excludes', async () => {
    store.setState({
      repos: [
        {
          id: 'repo-1',
          formatOnSave: {
            enabled: true,
            command: 'prettier --write ${file}',
            include: ['**/*.css']
          }
        }
      ]
    } as never)
    let pendingSeenDuringFormat: boolean | undefined
    formatOnSave.mockImplementation(async () => {
      pendingSeenDuringFormat = getRecentSelfWrite(FILE_ID, undefined)?.formatterPending
      return { status: 'skipped', reason: 'not-included' }
    })
    store.getState().setEditorDraft(FILE_ID, UNFORMATTED)
    await requestEditorFileSave({ fileId: FILE_ID })

    expect(pendingSeenDuringFormat).toBeUndefined()
  })

  it('restores the plain stamp when nothing was formatted', async () => {
    formatOnSave.mockResolvedValue({ status: 'skipped', reason: 'not-configured' })
    store.getState().setEditorDraft(FILE_ID, UNFORMATTED)
    await requestEditorFileSave({ fileId: FILE_ID })

    expect(getRecentSelfWrite(FILE_ID, undefined)).toEqual({ content: UNFORMATTED })
  })
})
