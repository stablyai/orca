import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { usePluginPanelsStore } from '@/store/plugin-panels'
import type { PluginHostListEntry } from '../../../../preload/api-types'
import type { EditorSaveHookDecision } from '../../../../shared/plugins/events/plugin-editor-save-hook'
import { createEditorSaveQueue, type EditorSaveQueue } from './editor-save-queue'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'
import {
  createEditorStore,
  createFakeEditorDisk,
  stubEditorWindowWithDisk,
  withLoadedBaselines,
  type FakeEditorDisk
} from './editor-autosave-controller-test-fixture'
import { EditorSaveDeniedByPluginError } from './editor-save-plugin-hook'

vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))

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

  it('writes what the hook returns and takes it into the buffer, leaving the tab clean', async () => {
    edit('  x  ')
    expect(await queue.queueSave(file(), '  x  ')).toBe('written')
    expect(hook).toHaveBeenCalledWith({
      workspaceId: 'wt-1',
      path: 'src/a.ts',
      languageId: 'typescript',
      text: '  x  '
    })
    expect(written()).toEqual(['x\n'])
    expect(file().isDirty).toBe(false)
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

  it('never asks for autosaves, or when no live plugin lists the hook', async () => {
    edit('x')
    expect(await queue.queueSave(file(), 'x', 'autosave')).toBe('written')
    usePluginPanelsStore.setState({ plugins: [hookingPlugin('pending')] })
    edit('y')
    expect(await queue.queueSave(file(), 'y')).toBe('written')
    expect(hook).not.toHaveBeenCalled()
    expect(written()).toEqual(['x', 'y'])
  })
})
