// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { editorModelRegistry } from '@/lib/editor-model-registry'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { usePluginPanelsStore } from '@/store/plugin-panels'
import { requestEditorFileSave } from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { createEditorStore } from './editor-autosave-controller-test-fixture'
import { editorTabModelUri, type EditorSaveTrigger } from './editor-save-disk-precondition'
import { openGuardedFile, stubGuardedDisk } from './editor-save-guarded-disk-fixture'
import { createEditorSaveQueue } from './editor-save-queue'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'

const storeRef = vi.hoisted((): { current: StoreApi<AppState> | null } => ({ current: null }))

vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => null }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeRef.current?.getState() } }))
vi.mock('@/lib/file-owner-runtime-target', () => ({
  getRuntimeTargetForFileOwner: () => ({ kind: 'local' })
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))

const PATH = '/repo/pnpm-workspace.yaml'
const BASELINE = 'packages: []\n'

function openFile(options: {
  enabled?: boolean
  draft: string
  baseline?: string
  path?: string
  language?: string
}) {
  const store = createEditorStore()
  storeRef.current = store
  store.setState({
    settings: {
      ...store.getState().settings!,
      editorAutoSave: false,
      editorInsertFinalNewline: options.enabled
    },
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' })]
    }
  })
  const fileId = openGuardedFile(store, {
    filePath: options.path ?? PATH,
    language: options.language ?? 'yaml',
    baseline: options.baseline ?? BASELINE,
    draft: options.draft
  })
  return { store, fileId }
}

function createModel(store: StoreApi<AppState>, text: string) {
  const file = store.getState().openFiles[0]
  return monaco.editor.createModel(
    text,
    file.language,
    monaco.Uri.parse(editorTabModelUri(store.getState(), file))
  )
}

function createVisibleEditor(model: monaco.editor.ITextModel) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const editor = monaco.editor.create(host, { model })
  return {
    editor,
    dispose: () => {
      editor.dispose()
      host.remove()
    }
  }
}

function stubCanvasTextMetrics() {
  const context = {
    webkitBackingStorePixelRatio: 1,
    measureText: (value: string) => ({ width: value.length * 8 })
  }
  return vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Monaco only reads these metrics in this test.
    context as unknown as CanvasRenderingContext2D
  )
}

async function save(
  store: StoreApi<AppState>,
  fileId: string,
  options?: { baseline?: string; trigger?: EditorSaveTrigger }
) {
  const file = store.getState().openFiles.find((openFile) => openFile.id === fileId)!
  const disk = stubGuardedDisk({ [file.filePath]: options?.baseline ?? BASELINE })
  if (!options?.trigger || options.trigger === 'user') {
    const cleanup = attachEditorAutosaveController(store)
    try {
      await requestEditorFileSave({ fileId })
    } finally {
      cleanup()
    }
  } else {
    const queue = createEditorSaveQueue(store)
    try {
      expect(
        await queue.queueSave(file, store.getState().editorDrafts[fileId] ?? '', options.trigger)
      ).toBe('written')
    } finally {
      queue.dispose()
    }
  }
  return disk.files
}

describe('saving with Insert Final Newline', () => {
  let unregister: () => void

  beforeEach(() => {
    unregister = editorModelRegistry.register(monaco)
    usePluginPanelsStore.setState({ plugins: [] })
    vi.clearAllMocks()
  })

  afterEach(() => {
    unregister()
    for (const model of monaco.editor.getModels()) {
      model.dispose()
    }
    __clearSelfWriteRegistryForTests()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    storeRef.current = null
  })

  it.each([
    ['appends LF', true, 'packages:\n  - app', 'packages:\n  - app\n'],
    ['preserves CRLF', true, 'packages:\r\n  - app', 'packages:\r\n  - app\r\n'],
    ['keeps an existing LF', true, 'packages:\n  - app\n', 'packages:\n  - app\n'],
    ['keeps an existing CRLF', true, 'packages:\r\n  - app\r\n', 'packages:\r\n  - app\r\n'],
    ['keeps a final CR', true, 'packages:\r', 'packages:\r'],
    ['leaves empty files empty', true, '', ''],
    ['does nothing when disabled', false, 'packages:\n  - app', 'packages:\n  - app'],
    ['does nothing when the setting is absent', undefined, 'packages: []', 'packages: []']
  ])('%s', async (_label, enabled, draft, written) => {
    const { store, fileId } = openFile({ enabled, draft })
    const files = await save(store, fileId)

    expect(files.get(PATH)).toBe(written)
    expect(store.getState().openFiles[0]?.isDirty).toBe(false)
  })

  it.each(['autosave', 'restart', 'overwrite', 'convert'] as const)(
    'inserts a newline for a %s save',
    async (trigger) => {
      const { store, fileId } = openFile({ enabled: true, draft: 'packages: []' })
      const files = await save(store, fileId, { trigger })

      expect(files.get(PATH)).toBe('packages: []\n')
      expect(store.getState().openFiles[0]?.isDirty).toBe(false)
    }
  )

  it('uses the retained CRLF model ending after its last line break is removed', async () => {
    const draft = 'packages: []'
    const { store, fileId } = openFile({ enabled: true, draft })
    const model = createModel(store, 'packages:\r\n  - app')
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: draft }], () => null)
    model.pushStackElement()

    const files = await save(store, fileId)

    expect(files.get(PATH)).toBe('packages: []\r\n')
    expect(model.getValue()).toBe('packages: []\r\n')
    await model.undo()
    expect(model.getValue()).toBe(draft)
    expect(model.getEOL()).toBe('\r\n')
  })

  it('keeps selections in every editor on the model and makes the save edit undoable', async () => {
    const draft = 'packages:\n  - app'
    const { store, fileId } = openFile({ enabled: true, draft })
    const model = createModel(store, draft)
    const getContext = stubCanvasTextMetrics()
    const first = createVisibleEditor(model)
    const second = createVisibleEditor(model)
    first.editor.setSelection(new monaco.Selection(2, 8, 2, 8))
    second.editor.setSelection(new monaco.Selection(2, 8, 2, 4))
    const firstSelection = first.editor.getSelections()
    const secondSelection = second.editor.getSelections()

    try {
      const files = await save(store, fileId)

      expect(files.get(PATH)).toBe(`${draft}\n`)
      expect(model.getValue()).toBe(`${draft}\n`)
      expect(first.editor.getSelections()).toEqual(firstSelection)
      expect(second.editor.getSelections()).toEqual(secondSelection)
      await model.undo()
      expect(model.getValue()).toBe(draft)
    } finally {
      first.dispose()
      second.dispose()
      getContext.mockRestore()
    }
  })

  it('updates the model without moving the cursor when disk text has mixed line endings', async () => {
    const baseline = 'first\r\nsecond\nthird'
    const { store, fileId } = openFile({ enabled: true, draft: baseline, baseline })
    const model = createModel(store, baseline)
    const getContext = stubCanvasTextMetrics()
    const { editor, dispose } = createVisibleEditor(model)
    editor.setPosition({ lineNumber: 3, column: 6 })
    const selection = editor.getSelections()
    store.getState().clearEditorDraft(fileId)
    store.getState().markFileDirty(fileId, false)
    const disk = stubGuardedDisk({ [PATH]: baseline })
    const cleanup = attachEditorAutosaveController(store)

    try {
      await requestEditorFileSave({ fileId, fallbackContent: baseline })

      expect(disk.files.get(PATH)).toBe(`${baseline}\n`)
      expect(model.getValue()).toBe(
        `first${model.getEOL()}second${model.getEOL()}third${model.getEOL()}`
      )
      expect(editor.getSelections()).toEqual(selection)
      expect(store.getState().openFiles[0]?.isDirty).toBe(false)
    } finally {
      cleanup()
      dispose()
      getContext.mockRestore()
    }
  })

  it.each([
    ['/repo/note.md', 'markdown'],
    ['/repo/table.csv', 'csv'],
    ['/repo/notebook.ipynb', 'json']
  ])('does not alter the structured editor for %s', async (path, language) => {
    const { store, fileId } = openFile({ enabled: true, draft: 'content', path, language })
    const files = await save(store, fileId)

    expect(files.get(path)).toBe('content')
  })

  it('applies to Markdown when its source code view is selected', async () => {
    const path = '/repo/note.md'
    const { store, fileId } = openFile({
      enabled: true,
      draft: 'content',
      path,
      language: 'markdown'
    })
    store.getState().setMarkdownViewMode(fileId, 'source')

    const files = await save(store, fileId)

    expect(files.get(path)).toBe('content\n')
  })

  it('does not replace a model that has newer edits than the captured draft', async () => {
    const { store, fileId } = openFile({ enabled: true, draft: 'captured' })
    const model = createModel(store, 'typed meanwhile')

    const files = await save(store, fileId)

    expect(files.get(PATH)).toBe('captured\n')
    expect(model.getValue()).toBe('typed meanwhile')
    expect(store.getState().editorDrafts[fileId]).toBe('captured')
    expect(store.getState().openFiles[0]?.isDirty).toBe(true)
  })

  it('adds a newline after formatter output and keeps the model and draft in sync', async () => {
    const { store, fileId } = openFile({ enabled: true, draft: 'packages:[]' })
    const model = createModel(store, 'packages:[]')
    store.setState({ settings: { ...store.getState().settings!, editorFormatOnSave: true } })
    vi.mocked(callRuntimeRpc).mockResolvedValueOnce({ kind: 'formatted', text: 'packages: []' })

    const files = await save(store, fileId)

    expect(files.get(PATH)).toBe('packages: []\n')
    expect(model.getValue()).toBe('packages: []\n')
    expect(store.getState().openFiles[0]?.isDirty).toBe(false)
  })

  it('adopts formatter output that already ends with a newline when saving a clean file', async () => {
    const baseline = 'packages:[]'
    const { store, fileId } = openFile({ enabled: true, draft: baseline, baseline })
    const model = createModel(store, baseline)
    store.getState().clearEditorDraft(fileId)
    store.getState().markFileDirty(fileId, false)
    store.setState({ settings: { ...store.getState().settings!, editorFormatOnSave: true } })
    vi.mocked(callRuntimeRpc).mockResolvedValueOnce({ kind: 'formatted', text: 'packages: []\n' })
    const disk = stubGuardedDisk({ [PATH]: baseline })
    const cleanup = attachEditorAutosaveController(store)
    try {
      await requestEditorFileSave({ fileId, fallbackContent: baseline })

      expect(disk.files.get(PATH)).toBe('packages: []\n')
      expect(model.getValue()).toBe('packages: []\n')
      expect(store.getState().openFiles[0]?.isDirty).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('keeps newline and formatter changes undoable when the formatter changes CRLF to LF', async () => {
    const draft = 'packages:\r\n  - app'
    const { store, fileId } = openFile({ enabled: true, draft })
    const model = createModel(store, draft)
    store.setState({ settings: { ...store.getState().settings!, editorFormatOnSave: true } })
    vi.mocked(callRuntimeRpc).mockResolvedValueOnce({
      kind: 'formatted',
      text: 'packages:\n  - app'
    })

    const files = await save(store, fileId)

    expect(files.get(PATH)).toBe('packages:\n  - app\n')
    expect(model.getValue()).toBe('packages:\n  - app\n')
    expect(model.getEOL()).toBe('\n')
    await model.undo()
    expect(model.getValue()).toBe(draft)
    expect(model.getEOL()).toBe('\r\n')
  })

  it('keeps the added newline dirty when the guarded write detects an external change', async () => {
    const { store, fileId } = openFile({ enabled: true, draft: 'my edit' })
    const model = createModel(store, 'my edit')
    const disk = stubGuardedDisk({ [PATH]: 'external change' })
    const cleanup = attachEditorAutosaveController(store)
    try {
      await expect(requestEditorFileSave({ fileId })).rejects.toThrow(/changed on disk/)

      expect(disk.files.get(PATH)).toBe('external change')
      expect(model.getValue()).toBe('my edit\n')
      expect(store.getState().editorDrafts[fileId]).toBe('my edit\n')
      expect(store.getState().openFiles[0]?.isDirty).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('does not replace edits typed while the formatter is running', async () => {
    const { store, fileId } = openFile({ enabled: true, draft: 'before' })
    const model = createModel(store, 'before')
    store.setState({ settings: { ...store.getState().settings!, editorFormatOnSave: true } })
    let finish!: (result: { kind: 'formatted'; text: string }) => void
    vi.mocked(callRuntimeRpc).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve))
    )
    const disk = stubGuardedDisk({ [PATH]: BASELINE })
    const cleanup = attachEditorAutosaveController(store)
    try {
      const saving = requestEditorFileSave({ fileId })
      await vi.waitFor(() => expect(callRuntimeRpc).toHaveBeenCalledOnce())
      model.pushEditOperations(
        [],
        [{ range: model.getFullModelRange(), text: 'typed' }],
        () => null
      )
      store.getState().setEditorDraft(fileId, 'typed')
      finish({ kind: 'formatted', text: 'formatted' })
      await saving

      expect(disk.files.get(PATH)).toBe('formatted\n')
      expect(model.getValue()).toBe('typed')
      expect(store.getState().editorDrafts[fileId]).toBe('typed')
      expect(store.getState().openFiles[0]?.isDirty).toBe(true)
    } finally {
      cleanup()
    }
  })
})
