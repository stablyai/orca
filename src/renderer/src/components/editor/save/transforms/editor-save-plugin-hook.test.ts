import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { usePluginPanelsStore } from '@/store/plugins/catalog/plugin-contribution-catalog'
import type { PluginHostListEntry } from '../../../../../../shared/plugins/plugin-list-entry'
import type { EditorSaveHookDecision } from '../../../../../../shared/plugins/events/plugin-editor-save-hook'
import { createEditorSaveQueue } from '../queue/editor-save-queue'
import type { EditorSaveQueue } from '../queue/editor-save-queue-contract'
import { __clearSelfWriteRegistryForTests } from '../../external-changes/editor-self-write-registry'
import {
  createEditorStore,
  createFakeEditorDisk,
  stubEditorWindowWithDisk,
  withLoadedBaselines,
  type FakeEditorDisk
} from '../../autosave/editor-autosave-controller-test-fixture'
import { EditorSaveDeniedByPluginError } from './editor-save-plugin-hook'
import { registerPendingEditorFlush } from '../flush/editor-pending-flush'

vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const PATH = '/repo/src/a.ts'

function hookingPlugin(status: PluginHostListEntry['status'] = 'running'): PluginHostListEntry {
  return {
    pluginKey: 'acme.fmt',
    consentFingerprint: null,
    name: 'Formatter',
    version: '1.0.0',
    publisher: 'acme',
    status,
    needsReconsent: false,
    isDev: false,
    official: false,
    bundled: false,
    capabilities: [],
    panels: [],
    commands: [],
    hasWorker: true,
    restarts: 0,
    hooks: ['editor.save.before']
  }
}

describe('editor.save.before on the save path', () => {
  let disk: FakeEditorDisk
  let store: ReturnType<typeof createEditorStore>
  let queue: EditorSaveQueue
  let hook: ReturnType<typeof vi.fn<(event: { text: string }) => Promise<EditorSaveHookDecision>>>

  const edit = (text: string): void => {
    store.getState().setEditorDraft('a', text)
    store.getState().markFileDirty('a', true)
  }
  const file = (): OpenFile => store.getState().openFiles.find((tab) => tab.id === 'a')!
  const written = (): string[] => disk.fs.writeFile.mock.calls.map(([args]) => args.content)
  const openMarkdownViews = (savingView: 'source' | 'rich', survivingView: 'source' | 'rich') => {
    const path = '/repo/src/a.md'
    disk.files.set(path, '')
    store.setState((state) => ({
      settings: { ...state.settings!, editorInsertFinalNewline: true },
      openFiles: ['a', 'b'].map((id) => ({
        ...file(),
        id,
        filePath: path,
        relativePath: 'src/a.md',
        language: 'markdown'
      }))
    }))
    store.getState().setMarkdownViewMode('a', savingView)
    store.getState().setMarkdownViewMode('b', survivingView)
    withLoadedBaselines(store, disk)
    return path
  }

  beforeEach(() => {
    disk = stubEditorWindowWithDisk(createFakeEditorDisk({ [PATH]: '' }))
    hook = vi.fn(async ({ text }) => ({ kind: 'continue' as const, text: `${text.trim()}\n` }))
    Object.assign(window.api, { plugins: { editorSaveHook: hook } })
    store = createEditorStore()
    store.setState({
      openFiles: [
        {
          id: 'a',
          filePath: PATH,
          relativePath: 'src/a.ts',
          worktreeId: 'wt-1',
          language: 'typescript',
          isDirty: false,
          mode: 'edit'
        }
      ]
    })
    withLoadedBaselines(store, disk)
    usePluginPanelsStore.setState({ plugins: [hookingPlugin()] })
    queue = createEditorSaveQueue(store)
  })

  afterEach(() => {
    queue.dispose()
    usePluginPanelsStore.setState({ plugins: [] })
    __clearSelfWriteRegistryForTests()
    vi.unstubAllGlobals()
  })

  it.each([
    ['source', 'rich', 'ONE\n'],
    ['rich', 'source', 'ONE']
  ] as const)(
    'keeps the %s save behavior when only a %s view survives the plugin',
    async (savingView, survivingView, expected) => {
      const path = openMarkdownViews(savingView, survivingView)
      hook.mockImplementationOnce(async ({ text }) => {
        store.setState((state) => ({ openFiles: state.openFiles.filter((tab) => tab.id !== 'a') }))
        return { kind: 'continue', text: text.toUpperCase() }
      })
      edit('one')

      expect(await queue.queueSave(file(), 'one')).toBe('written')
      expect(disk.files.get(path)).toBe(expected)
      expect(store.getState().openFiles.find((tab) => tab.id === 'b')?.isDirty).toBe(false)
    }
  )

  it('retains a source save when the writer closes before the queued save starts', async () => {
    const path = openMarkdownViews('source', 'rich')
    let finish!: (decision: EditorSaveHookDecision) => void
    hook
      .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
      .mockResolvedValueOnce({ kind: 'continue', text: 'TWO' })
    edit('one')
    const first = queue.queueSave(file(), 'one')
    await vi.waitFor(() => expect(hook).toHaveBeenCalledOnce())
    edit('two')
    const second = queue.queueSave(file(), 'two')
    store.setState((state) => ({ openFiles: state.openFiles.filter((tab) => tab.id !== 'a') }))
    finish({ kind: 'continue', text: 'ONE' })

    expect(await first).toBe('written')
    expect(await second).toBe('written')
    expect(disk.files.get(path)).toBe('TWO\n')
    expect(store.getState().openFiles.find((tab) => tab.id === 'b')?.isDirty).toBe(false)
  })

  it('keeps edits made while the hook ran unsaved and the tab dirty', async () => {
    let answer!: (decision: EditorSaveHookDecision) => void
    hook.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    edit('one')
    const saved = queue.queueSave(file(), 'one')
    await vi.waitFor(() => expect(hook).toHaveBeenCalledOnce())
    edit('one two')
    answer({ kind: 'continue', text: 'ONE' })
    expect(await saved).toBe('written')
    expect(written()).toEqual(['ONE'])
    expect(store.getState().editorDrafts.a).toBe('one two')
    expect(file().isDirty).toBe(true)
  })

  it('refuses the save on a deny, naming the plugin, and writes nothing', async () => {
    hook.mockResolvedValueOnce({ kind: 'deny', pluginKey: 'acme.fmt', reason: 'syntax error' })
    edit('x')
    await expect(queue.queueSave(file(), 'x')).rejects.toBeInstanceOf(EditorSaveDeniedByPluginError)
    expect(written()).toEqual([])
    expect(file().isDirty).toBe(true)
  })

  it('treats typing a view still holds when the hook returns as a newer edit', async () => {
    let unregister = (): void => {}
    hook.mockImplementationOnce(async () => {
      // A rich Markdown view serializes on a timer: this keystroke reaches the draft only on flush.
      unregister = registerPendingEditorFlush('a', () => edit('one!'))
      return { kind: 'continue', text: 'ONE' }
    })
    edit('one')
    expect(await queue.queueSave(file(), 'one')).toBe('written')
    unregister()
    expect(written()).toEqual(['ONE'])
    expect(store.getState().editorDrafts.a).toBe('one!')
    expect(file().isDirty).toBe(true)
  })
})
