import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readRuntimeFileContent: vi.fn(),
  runtimePathsExist: vi.fn()
}))

vi.mock('@/runtime/runtime-file-read-client', () => ({
  readRuntimeFileContent: mocks.readRuntimeFileContent
}))
vi.mock('@/runtime/runtime-path-existence-batch', () => ({
  runtimePathsExist: mocks.runtimePathsExist
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))
vi.mock('@/lib/file-owner-runtime-target', () => {
  const owner = { kind: 'environment', environmentId: 'env-1' }
  return {
    getRuntimeTargetForFileOwner: () => owner,
    requireRuntimeTargetForFileOwner: () => owner
  }
})

import { createTestStore } from '@/store/slices/store-test-helpers'
import {
  attachRestoredTabConflictScan,
  MAX_VERIFY_ATTEMPTS
} from './editor-restored-tab-conflict-scan'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'

const FILE = '/repo/a.ts'
let store: ReturnType<typeof createTestStore>
let detach: () => void

// A server's file is named by its owned id, not its path.
let fileId: string
const tab = () => store.getState().openFiles.find((file) => file.id === fileId)!

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  store = createTestStore()
  fileId = store.getState().openFile({
    filePath: FILE,
    relativePath: 'a.ts',
    worktreeId: 'wt-1',
    runtimeEnvironmentId: 'env-1',
    language: 'typescript',
    mode: 'edit'
  })
  store.getState().setEditorDraft(fileId, 'unsaved')
  store.getState().markFileDirty(fileId, true)
  store.getState().setLastKnownDiskSignature(fileId, getDiskBaselineSignature('v1'))
})

afterEach(() => {
  detach()
  vi.useRealTimers()
})

it('marks a dirty runtime-owned tab deleted when its host says the file is gone', async () => {
  mocks.readRuntimeFileContent.mockRejectedValue(new Error('read failed'))
  mocks.runtimePathsExist.mockResolvedValue([{ exists: false }])
  detach = attachRestoredTabConflictScan(store)
  await vi.advanceTimersByTimeAsync(0)

  expect(mocks.runtimePathsExist).toHaveBeenCalledWith(
    expect.objectContaining({ worktreePath: '/repo' }),
    [FILE],
    undefined,
    { codedAbsenceOnly: true }
  )
  expect(tab().externalMutation).toBe('deleted')
})

it('stops retrying without a banner when the disk can never be checked', async () => {
  mocks.readRuntimeFileContent.mockRejectedValue(new Error('host unreachable'))
  mocks.runtimePathsExist.mockResolvedValue([{ error: 'unverifiable' }])
  detach = attachRestoredTabConflictScan(store)
  await vi.advanceTimersByTimeAsync(10 * 60_000)

  expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(MAX_VERIFY_ATTEMPTS)
  // Why no banner: the guarded save refuses newer disk on its own.
  expect(tab().externalMutation).toBeUndefined()
})
