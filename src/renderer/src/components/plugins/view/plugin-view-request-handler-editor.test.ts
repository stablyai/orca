// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import { useAppStore } from '@/store'
import { useCustomEditorViewStore } from '@/store/plugin-custom-editors'
import { usePluginViewCaptureStore } from '@/store/plugin-view-capture'
import { handlePluginViewRequest } from './plugin-view-request-handler'

const capture = vi.hoisted(() => ({ captureOpenEditor: vi.fn() }))
vi.mock('./plugin-view-editor-capture', () => capture)

const KEY = 'acme.todos'
const initialState = useAppStore.getState()

function plugin(): PluginHostListEntry {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler and the stores read only these fields.
  return {
    pluginKey: KEY,
    name: 'Todos',
    status: 'idle',
    panels: [],
    customEditors: [
      { id: 'notes', title: 'Notes', extensions: ['.notes'], filenames: [], priority: 'option' }
    ],
    commands: []
  } as unknown as PluginHostListEntry
}

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { plugins: { list: vi.fn().mockResolvedValue([plugin()]) } }
  })
  useAppStore.setState({ activeView: 'terminal', activeWorktreeId: 'wt-1' })
  capture.captureOpenEditor.mockReset()
  capture.captureOpenEditor.mockResolvedValue({ requestId: 'r', ok: true })
})

afterEach(() => {
  useAppStore.setState(initialState, true)
  usePluginViewCaptureStore.getState().end()
})

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: open-editor reads only these store members, so partial rows stand in for whole workspaces.
const setStore = (patch: Record<string, unknown>) => useAppStore.setState(patch as never)

describe('open-editor', () => {
  it('opens the file in the workspace that holds its real path, with the plugin editor chosen', async () => {
    const openFile = vi.fn().mockReturnValue('file-1')
    setStore({
      openFile,
      worktreesByRepo: { r1: [{ id: 'wt-1', path: '/private/tmp/w', isArchived: false }] }
    })
    await expect(
      handlePluginViewRequest({
        requestId: 'r',
        kind: 'open-editor',
        pluginKey: KEY,
        editorId: 'notes',
        filePath: '/tmp/w/plan.notes',
        filePathAliases: ['/private/tmp/w/plan.notes'],
        fallbackFolder: '/private/tmp/w'
      })
    ).resolves.toEqual({ requestId: 'r', ok: true })
    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/private/tmp/w/plan.notes',
        relativePath: 'plan.notes',
        worktreeId: 'wt-1',
        mode: 'edit'
      }),
      { preview: false }
    )
    expect(useCustomEditorViewStore.getState().choices['file-1']).toBe(`${KEY}/notes`)
  })

  it("opens the file's folder as a folder workspace when no workspace holds it", async () => {
    const openFile = vi.fn().mockReturnValue('file-2')
    const addRepoPath = vi.fn(async () => {
      setStore({
        worktreesByRepo: { folder: [{ id: 'wt-folder', path: '/elsewhere', isArchived: false }] }
      })
      return { id: 'folder' }
    })
    setStore({
      openFile,
      addRepoPath,
      fetchWorktrees: vi.fn(async () => undefined),
      worktreesByRepo: {}
    })
    await handlePluginViewRequest({
      requestId: 'r',
      kind: 'open-editor',
      pluginKey: KEY,
      editorId: 'notes',
      filePath: '/elsewhere/plan.notes',
      fallbackFolder: '/elsewhere'
    })
    expect(addRepoPath).toHaveBeenCalledWith('/elsewhere', 'folder', { runtimeEnvironmentId: null })
    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'plan.notes', worktreeId: 'wt-folder' }),
      { preview: false }
    )
  })
})

describe('open-editor for a shot', () => {
  const shoot = (keepOpen: boolean) =>
    handlePluginViewRequest({
      requestId: 'r',
      kind: 'open-editor',
      pluginKey: KEY,
      editorId: 'notes',
      filePath: '/w/plan.notes',
      fallbackFolder: '/w',
      capture: {
        captureId: 'c',
        timeoutMs: 1_000,
        ...(keepOpen ? { keepOpen: true as const } : {})
      }
    })

  it('closes a tab it opened, but keeps an in-place tab and its unsaved edits', async () => {
    const closeFile = vi.fn()
    setStore({
      openFile: vi.fn().mockReturnValue('file-1'),
      openFiles: [],
      closeFile,
      getKnownWorktreeById: () => undefined,
      worktreesByRepo: { r1: [{ id: 'wt-1', path: '/w', isArchived: false }] }
    })
    await shoot(true)
    await handlePluginViewRequest({ requestId: 'e', kind: 'end-capture', captureId: 'c' })
    expect(closeFile).not.toHaveBeenCalled()
    await shoot(false)
    await handlePluginViewRequest({ requestId: 'e', kind: 'end-capture', captureId: 'c' })
    expect(closeFile).toHaveBeenCalledWith('file-1')
  })

  it('opens a file in the local folder workspace that holds it, not a new folder project', async () => {
    const openFile = vi.fn().mockReturnValue('file-3')
    const addRepoPath = vi.fn()
    setStore({
      openFile,
      openFiles: [],
      addRepoPath,
      worktreesByRepo: {},
      folderWorkspaces: [{ id: 'f1', folderPath: '/w', connectionId: null, isArchived: false }]
    })
    await shoot(false)
    expect(addRepoPath).not.toHaveBeenCalled()
    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'plan.notes', worktreeId: 'folder:f1' }),
      { preview: false }
    )
  })
})
