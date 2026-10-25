// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import { createEditorStore } from './editor-autosave-controller-test-fixture'
import { createEditorSaveQueue } from './editor-save-queue'
import { toEditorModelUri } from './editor-model-uri'
import { installMonacoEditorInputBindings } from './monaco-editor-input-bindings'
import { MONACO_PASTE_DIRECT_MAX_BYTES } from './monaco-large-text-paste'
import { compareDiskWritePrecondition } from '../../../../shared/file-write-disk-precondition'
import type { GuardedWriteArgs } from './editor-save-guarded-disk-fixture'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))
vi.mock('./editor-shortcuts', () => ({
  installEditorAddReviewNoteShortcut: () => () => undefined,
  installEditorSaveShortcut: () => () => undefined,
  installMonacoEditorFindShortcut: () => () => undefined
}))

const PATH = '/repo/file.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function createSingleLineEditor(initial: string) {
  let value = initial
  let selection = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const model = { uri: { toString: () => toEditorModelUri(PATH) }, getValue: () => value }
  const editorStub = {
    getModel: () => model,
    getContainerDomNode: () => container,
    hasTextFocus: () => true,
    getValue: () => value,
    getSelection: () => selection,
    setSelection: (next: typeof selection) => {
      selection = next
    },
    executeEdits: (_source: string, edits: { text: string }[]) => {
      const at = selection.startColumn - 1
      value = value.slice(0, at) + edits[0].text + value.slice(at)
      return true
    },
    pushUndoStop: () => true,
    addAction: () => ({ dispose: () => undefined })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bindings and chunked paste call only the methods stubbed above.
  return { container, editorInstance: editorStub as unknown as editor.IStandaloneCodeEditor }
}

function pasteIntoGuardedTab(pasted: string) {
  const files = new Map([[PATH, 'base']])
  const writeFile = vi.fn(async (args: GuardedWriteArgs) => {
    const conflict = args.diskPrecondition
      ? compareDiskWritePrecondition(
          args.diskPrecondition,
          files.get(args.filePath) ?? null,
          args.content
        )
      : null
    if (conflict === 'identical') {
      return { ok: true, unchanged: true }
    }
    if (conflict) {
      return { ok: false, diskConflict: conflict }
    }
    files.set(args.filePath, args.content)
    return { ok: true }
  })
  vi.stubGlobal('api', { fs: { writeFile } })
  const store = createEditorStore()
  store.getState().openFile({
    filePath: PATH,
    relativePath: 'file.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    mode: 'edit'
  })
  store.getState().setLastKnownDiskSignature(PATH, getDiskBaselineSignature('base'))
  store.getState().setEditorDraft(PATH, 'base')
  store.getState().markFileDirty(PATH, true)
  const queue = createEditorSaveQueue(store)

  const { container, editorInstance } = createSingleLineEditor('base')
  const onContentChange = vi.fn((value: string) => store.getState().setEditorDraft(PATH, value))
  installMonacoEditorInputBindings({
    editorInstance,
    worktreeId: undefined,
    editorContainerRef: { current: container },
    propsRef: {
      current: { relativePath: 'file.ts', language: 'typescript', onSave: vi.fn(), onContentChange }
    },
    readOnlyRef: { current: false },
    lastSyncedContentRef: { current: 'base' },
    isApplyingLargePasteRef: { current: false },
    commentPopoverRef: { current: null },
    shouldShowMarkdownAnnotationsRef: { current: false },
    setCommentPopover: vi.fn(),
    setSelectionAnnotationTarget: vi.fn()
  })

  const paste = new Event('paste', { cancelable: true })
  Object.defineProperty(paste, 'clipboardData', { value: { getData: () => pasted } })
  container.dispatchEvent(paste)

  return { files, writeFile, store, queue, onContentChange }
}

it('holds autosave while a chunked paste is in flight, then saves the pasted text guarded', async () => {
  const pasted = 'x'.repeat(MONACO_PASTE_DIRECT_MAX_BYTES * 2)
  const { files, writeFile, store, queue, onContentChange } = pasteIntoGuardedTab(pasted)

  // Mid-paste the draft still holds the pre-paste text; autosave must not write it.
  expect(await queue.queueSave(store.getState().openFiles[0], 'base', 'autosave')).toBe('failed')
  expect(writeFile).not.toHaveBeenCalled()

  await vi.waitFor(() => expect(onContentChange).toHaveBeenCalled())
  expect(await queue.queueSave(store.getState().openFiles[0], 'base', 'autosave')).toBe('written')
  expect(files.get(PATH)).toBe(`${pasted}base`)
  expect(writeFile).toHaveBeenCalledWith(
    expect.objectContaining({
      diskPrecondition: {
        expectedSignature: getDiskBaselineSignature('base'),
        allowMissing: false,
        requireLosslessUtf8: true
      }
    })
  )
  queue.dispose()
})

it('refuses a save after a 70 KiB paste when an agent wrote the file meanwhile', async () => {
  const pasted = 'y'.repeat(70 * 1024)
  const { files, writeFile, store, queue, onContentChange } = pasteIntoGuardedTab(pasted)
  await vi.waitFor(() => expect(onContentChange).toHaveBeenCalled())
  files.set(PATH, 'agent rewrite')

  expect(await queue.queueSave(store.getState().openFiles[0], 'base', 'user')).toBe('blocked-stale')
  expect(writeFile).toHaveBeenCalledWith(
    expect.objectContaining({
      content: `${pasted}base`,
      diskPrecondition: {
        expectedSignature: getDiskBaselineSignature('base'),
        allowMissing: true,
        requireLosslessUtf8: true
      }
    })
  )
  expect(files.get(PATH)).toBe('agent rewrite')
  expect(store.getState().openFiles[0]?.externalMutation).toBe('changed')
  queue.dispose()
})
