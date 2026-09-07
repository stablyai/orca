import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as EditorAutosaveModule from '@/components/editor/editor-autosave'
import type * as CrossPlatformPathModule from '../../../shared/cross-platform-path'
import type { FsChangedPayload } from '../../../shared/filesystem-entry-types'

const pathOperationCounts = vi.hoisted(() => ({
  aliasComparisons: 0,
  normalizations: 0,
  identities: 0
}))

vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))
vi.mock('@/components/editor/editor-autosave', async (importOriginal) => {
  const actual = await importOriginal<typeof EditorAutosaveModule>()
  return { ...actual, notifyEditorExternalFileChange: vi.fn() }
})
vi.mock('../../../shared/cross-platform-path', async (importOriginal) => {
  type PathModuleWithIdentity = typeof CrossPlatformPathModule & {
    getLocalWindowsWslPathIdentity?: (value: string) => unknown
  }
  const actual = await importOriginal<PathModuleWithIdentity>()
  return {
    ...actual,
    normalizeRuntimePathForComparison: (value: string) => {
      pathOperationCounts.normalizations++
      return actual.normalizeRuntimePathForComparison(value)
    },
    areLocalWindowsWslPathAliases: (left: string, right: string) => {
      pathOperationCounts.aliasComparisons++
      return actual.areLocalWindowsWslPathAliases(left, right)
    },
    ...(actual.getLocalWindowsWslPathIdentity
      ? {
          getLocalWindowsWslPathIdentity: (value: string) => {
            pathOperationCounts.identities++
            return actual.getLocalWindowsWslPathIdentity!(value)
          }
        }
      : {})
  }
})

import { useAppStore } from '@/store'
import {
  getOpenFilesForExternalFileChange,
  notifyEditorExternalFileChange
} from '@/components/editor/editor-autosave'
import { createExternalWatchEventHandler } from './useEditorExternalWatch'

const EVENT_COUNT = 5_000
const OPEN_FILE_COUNT = 100
const payloadWorktreePath = '\\\\wsl.localhost\\Ubuntu\\workspace\\repo'

describe('external watcher path matching complexity', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.clearAllMocks()
    pathOperationCounts.aliasComparisons = 0
    pathOperationCounts.normalizations = 0
    pathOperationCounts.identities = 0
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
    vi.stubGlobal('navigator', { userAgent: 'Windows' })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('bounds a maximum-sized opposite-alias batch by events plus open files', () => {
    const openFiles = Array.from({ length: OPEN_FILE_COUNT }, (_, index) => ({
      id: `//wsl.localhost/Ubuntu/workspace/repo/file-${index}.ts`,
      filePath: `//wsl.localhost/Ubuntu/workspace/repo/file-${index}.ts`,
      relativePath: `file-${index}.ts`,
      worktreeId: 'wt-wsl',
      mode: 'edit' as const,
      isDirty: false
    }))
    const initialOpenFiles = [
      ...openFiles,
      {
        id: 'combined-diff',
        filePath: payloadWorktreePath,
        relativePath: '',
        worktreeId: 'wt-wsl',
        mode: 'diff' as const,
        diffSource: 'combined-uncommitted' as const,
        isDirty: false
      }
    ]
    vi.mocked(useAppStore.getState).mockReturnValue({
      openFiles: initialOpenFiles,
      setExternalMutation: vi.fn()
    } as never)
    const payload: FsChangedPayload = {
      worktreePath: payloadWorktreePath,
      events: Array.from({ length: EVENT_COUNT }, (_, index) => ({
        kind: 'update' as const,
        absolutePath: `\\\\wsl.localhost\\Ubuntu\\workspace\\repo\\file-${index}.ts`
      }))
    }
    const { handleFsChanged, dispose } = createExternalWatchEventHandler(() => ({
      worktreeId: 'wt-wsl',
      worktreePath: payload.worktreePath,
      connectionId: undefined,
      runtimeEnvironmentId: null,
      allowLocalWindowsWslAliases: true
    }))

    const startedAt = process.hrtime.bigint()
    handleFsChanged(payload)
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
    vi.advanceTimersByTime(100)
    expect(notifyEditorExternalFileChange).toHaveBeenCalledTimes(EVENT_COUNT)
    // Why: a tab/store update during debounce must rebuild the index once, not rescan per event.
    const currentOpenFiles = initialOpenFiles.map((file) => ({ ...file }))
    for (const [notification] of vi.mocked(notifyEditorExternalFileChange).mock.calls) {
      getOpenFilesForExternalFileChange(currentOpenFiles as never, notification)
    }
    const pathOperations =
      pathOperationCounts.aliasComparisons +
      pathOperationCounts.normalizations +
      pathOperationCounts.identities

    console.info('STA-3942 watcher oracle', { ...pathOperationCounts, pathOperations, elapsedMs })
    expect(pathOperations).toBeLessThanOrEqual(3 * (EVENT_COUNT + initialOpenFiles.length))
    dispose()
  })
})
