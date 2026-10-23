import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { advanceRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status-connection-generation'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '@/runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { createEditorSaveQueue } from './editor-save-queue'
import { __clearSelfWriteRegistryForTests, hasRecentSelfWrite } from './editor-self-write-registry'
import {
  createEditorStore,
  stubEditorWindowWithDisk,
  withLoadedBaselines
} from './editor-autosave-controller-test-fixture'

vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))

describe('restart admission across remote preflight', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    __clearSelfWriteRegistryForTests()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  it.each(['legacy comparison', 'no-send reconnect retry'])(
    'expires at beforeSend after delayed %s and clears the provisional stamp',
    async (boundary) => {
      clearRuntimeCompatibilityCacheForTests()
      stubEditorWindowWithDisk()
      let release = (): void => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let probes = 0
      const writes = vi.fn().mockResolvedValue({ ok: true, result: { ok: true } })
      const call = vi.fn(async (args: RuntimeEnvironmentCallRequest) => {
        const status = createCompatibleRuntimeStatusResponseIfNeeded(args, 'runtime-env-1')
        if (status?.ok) {
          probes += 1
          if (boundary === 'no-send reconnect retry') {
            if (probes === 1) {
              advanceRuntimeEnvironmentConnectionGeneration('env-1')
            }
            if (probes === 2) {
              await gate
            }
            return status
          }
          return {
            ...status,
            result: { ...status.result, capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] }
          }
        }
        if (args.method === 'files.read') {
          await gate
          return { ok: true, result: { content: '', truncated: false, byteLength: 0 } }
        }
        return writes(args)
      })
      vi.stubGlobal('window', { ...window, api: { ...window.api, runtimeEnvironments: { call } } })
      const store = createEditorStore()
      store.setState({
        worktreesByRepo: {
          'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/remote/repo' })]
        }
      })
      const id = store.getState().openFile({
        filePath: '/remote/repo/file.ts',
        relativePath: 'file.ts',
        worktreeId: 'wt-1',
        runtimeEnvironmentId: 'env-1',
        language: 'typescript',
        mode: 'edit'
      })
      store.getState().setEditorDraft(id, 'edited')
      store.getState().markFileDirty(id, true)
      const queue = createEditorSaveQueue(withLoadedBaselines(store))
      try {
        const file = store.getState().openFiles[0]
        const save = queue.queueSave(file, 'edited', 'autosave', performance.now() + 5000)
        await vi.advanceTimersByTimeAsync(0)
        expect(hasRecentSelfWrite(file.filePath, 'env-1')).toBe(true)
        expect(
          boundary === 'legacy comparison'
            ? call.mock.calls.some(([args]) => args.method === 'files.read')
            : probes >= 2
        ).toBe(true)
        await vi.advanceTimersByTimeAsync(5001)
        release()
        expect(await save).toBe('failed')
        expect(writes).not.toHaveBeenCalled()
        expect(hasRecentSelfWrite(file.filePath, 'env-1')).toBe(false)
        expect(store.getState().editorDrafts[id]).toBe('edited')
        expect(store.getState().openFiles[0].isDirty).toBe(true)
      } finally {
        queue.dispose()
      }
    }
  )
})
