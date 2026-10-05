import { setImmediate as nextTurn } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT } from '../../../../shared/editor-save-events'
import { ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, requestEditorFileSave } from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { createEditorStore, stubEditorWindow } from './editor-autosave-controller-test-fixture'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'

vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))

async function collect(): Promise<void> {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  for (let round = 0; round < 4; round += 1) {
    await nextTurn()
    globalThis.gc()
  }
}

function requestRestartSave(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    window.dispatchEvent(
      new CustomEvent(ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT, {
        detail: { claim: () => {}, resolve, reject }
      })
    )
  })
}

describe('editor save backlog retention', () => {
  afterEach(() => {
    __clearSelfWriteRegistryForTests()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it.each(['draft', 'fallback', 'restart', 'save-close', 'autosave'] as const)(
    'keeps only the newest queued %s content while one write stalls',
    async (route) => {
      const write = stubEditorWindow()
      let release = (): void => {}
      const blocked = new Promise<void>((resolve) => {
        release = resolve
      })
      write.mockReturnValueOnce(blocked).mockResolvedValue(undefined)
      const store = createEditorStore()
      const settings = store.getState().settings
      if (!settings) {
        throw new Error('Missing test settings')
      }
      store.setState({
        settings: { ...settings, editorAutoSave: false },
        browserTabsByWorktree: {},
        tabsByWorktree: {},
        recentlyClosedTabKindsByWorktree: {},
        worktreesByRepo: {
          'repo-1': store.getState().worktreesByRepo['repo-1'].map((worktree) => ({
            ...worktree,
            path: '/repo'
          }))
        }
      })
      const fileId = store.getState().openFile({
        filePath: '/repo/file.txt',
        relativePath: 'file.txt',
        worktreeId: 'wt-1',
        mode: 'edit',
        language: 'text'
      })
      const detach = attachEditorAutosaveController(store)
      store.getState().setEditorDraft(fileId, 'initial')
      store.getState().markFileDirty(fileId, true)
      const first = requestEditorFileSave({ fileId })
      await nextTurn()
      expect(write).toHaveBeenCalledTimes(1)
      if (route === 'fallback') {
        store.getState().clearEditorDraft(fileId)
      }
      if (route === 'autosave') {
        store.setState({
          settings: { ...settings, editorAutoSave: true, editorAutoSaveDelayMs: 250 }
        })
      }
      await collect()
      const baseline = process.memoryUsage().external
      const operations: Promise<void>[] = []
      for (let index = 0; index < 32; index += 1) {
        const content = Buffer.alloc(2 * 1024 * 1024, (index % 26) + 65).toString('utf8')
        if (route === 'fallback') {
          operations.push(
            requestEditorFileSave({ fileId, fallbackContent: content }).catch((error: Error) => {
              if (!error.message.includes('superseded')) {
                throw error
              }
            })
          )
          continue
        }
        store.getState().setEditorDraft(fileId, content)
        if (route === 'save-close') {
          window.dispatchEvent(
            new CustomEvent(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, { detail: { fileId } })
          )
          continue
        }
        if (route === 'autosave') {
          // Real timers keep the harness from retaining callbacks that already fired.
          await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 270))
          continue
        }
        operations.push(
          route === 'restart' ? requestRestartSave() : requestEditorFileSave({ fileId })
        )
      }
      try {
        await collect()
        expect(process.memoryUsage().external - baseline).toBeLessThan(8 * 1024 * 1024)
        expect(write).toHaveBeenCalledTimes(1)
      } finally {
        release()
        await Promise.all([first, ...operations])
        await nextTurn()
        detach()
      }
      expect(write).toHaveBeenCalledTimes(2)
      expect(write.mock.calls[1]?.[0]?.content).toBe('F'.repeat(2 * 1024 * 1024))
    }
  )
})
