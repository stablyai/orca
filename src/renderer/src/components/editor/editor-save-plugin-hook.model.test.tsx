// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import type { editor } from 'monaco-editor'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { usePluginPanelsStore } from '@/store/plugin-panels'
import type { OpenFile } from '@/store/slices/editor'
import type { PluginHostListEntry } from '../../../../preload/api-types'
import type { EditorSaveHookDecision } from '../../../../shared/plugins/events/plugin-editor-save-hook'
import { applyEditorSavePluginHook } from './editor-save-plugin-hook'
import { useMonacoContentSyncBridge } from './use-monaco-content-sync-bridge'

const MODEL_KEY = 'file:///repo/src/a.ts'

/** Just enough of a Monaco editor and model for the content-sync bridge. */
function fakeEditor(initial: string) {
  let value = initial
  const listeners = new Set<() => void>()
  const model = {
    uri: { toString: () => MODEL_KEY },
    getEOL: () => '\n',
    getValue: () => value,
    getFullModelRange: () => ({}),
    pushEditOperations: (_selections: unknown, edits: { text: string }[]) => {
      value = edits[0]?.text ?? value
      listeners.forEach((listener) => listener())
      return null
    },
    applyEdits: (edits: { text: string }[]) => {
      value = edits[0]?.text ?? value
    }
  }
  const instance = {
    getModel: () => model,
    getValue: () => value,
    pushUndoStop: () => true,
    onDidChangeModelContent: (listener: () => void) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    /** What a keystroke does: the model changes and the editor reports it. */
    type: (next: string) => {
      value = next
      listeners.forEach((listener) => listener())
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bridge and sync call only the members above.
  return instance as unknown as editor.IStandaloneCodeEditor & { type(next: string): void }
}

const FILE: OpenFile = {
  id: 'a',
  filePath: '/repo/src/a.ts',
  relativePath: 'src/a.ts',
  worktreeId: 'wt-1',
  language: 'typescript',
  isDirty: true,
  mode: 'edit'
}

/** The editor surface's wiring: content is the draft, else the disk text; edits write the draft. */
function Surface({ instance }: { instance: editor.IStandaloneCodeEditor }) {
  const content = useAppStore((state) => state.editorDrafts.a ?? '')
  useMonacoContentSyncBridge({
    editorRef: { current: instance },
    mountedEditor: instance,
    content,
    contentRef: { current: content },
    contentSyncModeRef: { current: 'undoable' },
    modelKey: MODEL_KEY,
    fileId: 'a',
    onContentChange: (value) => useAppStore.getState().setEditorDraft('a', value)
  })
  return null
}

function hookingPlugin(): PluginHostListEntry {
  return {
    pluginKey: 'acme.fmt',
    consentFingerprint: null,
    name: 'Formatter',
    version: '1.0.0',
    publisher: 'acme',
    status: 'running',
    restarts: 0,
    needsReconsent: false,
    isDev: false,
    official: false,
    bundled: false,
    capabilities: [],
    panels: [],
    commands: [],
    hasWorker: true,
    hooks: ['editor.save.before']
  }
}

let hook: ReturnType<typeof vi.fn<(event: { text: string }) => Promise<EditorSaveHookDecision>>>

beforeEach(() => {
  hook = vi.fn(async ({ text }) => ({ kind: 'continue' as const, text: `${text.trim()}\n` }))
  Object.assign(window, { api: { plugins: { editorSaveHook: hook } } })
  usePluginPanelsStore.setState({ plugins: [hookingPlugin()] })
  useAppStore.setState({ openFiles: [FILE], editorDrafts: { a: '  x  ' } })
})

afterEach(() => {
  cleanup()
  usePluginPanelsStore.setState({ plugins: [] })
  useAppStore.setState({ openFiles: [], editorDrafts: {} })
})

describe('editor.save.before reaches the visible Monaco model', () => {
  it('shows the formatted text, and the next keystroke edits it rather than the old text', async () => {
    const instance = fakeEditor('  x  ')
    render(<Surface instance={instance} />)
    await expect(applyEditorSavePluginHook(useAppStore, FILE, '  x  ')).resolves.toBe('x\n')
    expect(instance.getValue()).toBe('x\n')
    instance.type('x\ny')
    expect(useAppStore.getState().editorDrafts.a).toBe('x\ny')
  })

  it('keeps edits typed while the hook ran in the model', async () => {
    let answer!: (decision: EditorSaveHookDecision) => void
    hook.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    const instance = fakeEditor('  x  ')
    render(<Surface instance={instance} />)
    const saved = applyEditorSavePluginHook(useAppStore, FILE, '  x  ')
    instance.type('  x  !')
    answer({ kind: 'continue', text: 'x\n' })
    await expect(saved).resolves.toBe('x\n')
    expect(instance.getValue()).toBe('  x  !')
    expect(useAppStore.getState().editorDrafts.a).toBe('  x  !')
  })
})
