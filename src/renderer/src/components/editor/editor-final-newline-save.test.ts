// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store'
import { editorModelRegistry } from '@/lib/editor-model-registry'
import { requestEditorFileSave } from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { createEditorStore } from './editor-autosave-controller-test-fixture'
import { editorTabModelUri } from './editor-save-disk-precondition'
import { openGuardedFile, stubGuardedDisk } from './editor-save-guarded-disk-fixture'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'

const storeRef = vi.hoisted((): { current: StoreApi<AppState> | null } => ({ current: null }))

vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => null }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeRef.current?.getState() } }))
vi.mock('@/lib/file-owner-runtime-target', () => ({
  getRuntimeTargetForFileOwner: () => ({ kind: 'local' })
}))

const PATH = '/repo/pnpm-workspace.yaml'
const DISK = 'packages: []\n'

function openWorkspaceFile(options: { enabled: boolean; draft: string }) {
  const store = createEditorStore()
  storeRef.current = store
  store.setState({
    settings: {
      ...store.getState().settings!,
      editorAutoSave: false,
      editorInsertFinalNewline: options.enabled
    }
  })
  const fileId = openGuardedFile(store, {
    filePath: PATH,
    language: 'yaml',
    baseline: DISK,
    draft: options.draft
  })
  return { store, fileId }
}

/** Stubs the window last: Monaco editors must be created against the real DOM window. */
async function save(store: StoreApi<AppState>, fileId: string): Promise<Map<string, string>> {
  const { files } = stubGuardedDisk({ [PATH]: DISK })
  const cleanup = attachEditorAutosaveController(store)
  try {
    await requestEditorFileSave({ fileId })
  } finally {
    cleanup()
  }
  return files
}

describe('saving with Insert Final Newline', () => {
  let unregister: () => void = () => {}

  beforeEach(() => {
    unregister = editorModelRegistry.register(monaco)
  })

  afterEach(() => {
    unregister()
    for (const model of monaco.editor.getModels()) {
      model.dispose()
    }
    __clearSelfWriteRegistryForTests()
    vi.unstubAllGlobals()
    storeRef.current = null
  })

  it.each([
    ['appends LF when enabled', true, 'packages:\n  - app', 'packages:\n  - app\n'],
    ['keeps CRLF files on CRLF', true, 'packages:\r\n  - app', 'packages:\r\n  - app\r\n'],
    [
      'leaves an existing final newline alone',
      true,
      'packages:\n  - app\n',
      'packages:\n  - app\n'
    ],
    ['leaves empty files empty', true, '', ''],
    ['writes the text unchanged when disabled', false, 'packages:\n  - app', 'packages:\n  - app']
  ])('%s', async (_label, enabled, draft, written) => {
    const { store, fileId } = openWorkspaceFile({ enabled, draft })

    const files = await save(store, fileId)

    expect(files.get(PATH)).toBe(written)
    expect(store.getState().openFiles[0]?.isDirty).toBe(false)
  })

  it('uses LF after a CRLF model is reduced to one line and keeps the save edit undoable', async () => {
    const draft = 'packages: []'
    const { store, fileId } = openWorkspaceFile({ enabled: true, draft })
    const model = monaco.editor.createModel(
      'packages:\r\n  - app',
      'yaml',
      monaco.Uri.parse(editorTabModelUri(store.getState(), store.getState().openFiles[0]!))
    )
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: draft }], () => null)
    model.pushStackElement()
    expect(model.getEOL()).toBe('\r\n')

    const files = await save(store, fileId)

    expect(files.get(PATH)).toBe('packages: []\n')
    expect(model.getValue()).toBe('packages: []\n')
    expect(store.getState().openFiles[0]?.isDirty).toBe(false)
    await model.undo()
    expect(model.getValue()).toBe(draft)
    expect(model.getEOL()).toBe('\r\n')
    await model.redo()
    expect(model.getValue()).toBe('packages: []\n')
    expect(model.getEOL()).toBe('\n')
  })

  it('adds the newline to the open model without moving the cursor', async () => {
    const draft = 'packages:\n  - app'
    const { store, fileId } = openWorkspaceFile({ enabled: true, draft })
    const model = monaco.editor.createModel(
      draft,
      'yaml',
      monaco.Uri.parse(editorTabModelUri(store.getState(), store.getState().openFiles[0]!))
    )
    // Only text metrics are needed; this test does not inspect canvas painting.
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: editor construction reads only these canvas members.
      .mockReturnValue({
        webkitBackingStorePixelRatio: 1,
        measureText: (value: string) => ({ width: value.length * 8 })
      } as never)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const editor = monaco.editor.create(host, { model })
    editor.setPosition({ lineNumber: 2, column: 8 })

    try {
      const files = await save(store, fileId)

      expect(files.get(PATH)).toBe('packages:\n  - app\n')
      expect(model.getValue()).toBe('packages:\n  - app\n')
      expect(editor.getPosition()?.toJSON()).toEqual({ lineNumber: 2, column: 8 })
      expect(store.getState().openFiles[0]?.isDirty).toBe(false)
    } finally {
      editor.dispose()
      host.remove()
      getContext.mockRestore()
    }
  })
})
