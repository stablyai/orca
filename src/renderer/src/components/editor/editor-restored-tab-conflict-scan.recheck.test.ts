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
  getRestoredTabReverificationRequestCountForTest,
  MAX_VERIFY_ATTEMPTS,
  requestRestoredTabReverification
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

it('reads once more when a new check is requested while a read is in flight', async () => {
  const replies: ((content: string) => void)[] = []
  mocks.readRuntimeFileContent.mockImplementation(
    () => new Promise((resolve) => replies.push((content) => resolve({ content, isBinary: false })))
  )
  store.getState().setPendingDiskBaselineVerification(fileId, true)
  detach = attachRestoredTabConflictScan(store)
  await vi.advanceTimersByTimeAsync(0)
  expect(replies).toHaveLength(1)

  // A second catch-up lands mid-read, after an external write.
  requestRestoredTabReverification(fileId)
  requestRestoredTabReverification(fileId)
  replies[0]('v1')
  await vi.advanceTimersByTimeAsync(0)
  expect(tab().pendingDiskBaselineVerification).toBe(true)
  // Coalesced: two requests mid-read still cost one more read.
  expect(replies).toHaveLength(2)

  replies[1]('v2 external write')
  await vi.advanceTimersByTimeAsync(0)
  expect(tab().externalMutation).toBe('changed')
  expect(tab().pendingDiskBaselineVerification).toBeFalsy()
})

it.each([
  { disk: 'v1', banner: undefined },
  { disk: 'v2 external write', banner: 'changed' }
])('waits out overlapping checks, then judges a fresh read ($disk)', async ({ disk, banner }) => {
  const replies: ((content: string) => void)[] = []
  mocks.readRuntimeFileContent.mockImplementation(
    () => new Promise((resolve) => replies.push((content) => resolve({ content, isBinary: false })))
  )
  store.getState().setPendingDiskBaselineVerification(fileId, true)
  detach = attachRestoredTabConflictScan(store)
  await vi.advanceTimersByTimeAsync(0)
  expect(replies).toHaveLength(1)

  // Every read is slower than the re-verify interval, so a newer check always lands first.
  for (let i = 0; i < MAX_VERIFY_ATTEMPTS + 5; i += 1) {
    requestRestoredTabReverification(fileId)
    replies[i]('v1')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(replies).toHaveLength(i + 2)
  }
  expect(tab().pendingDiskBaselineVerification).toBe(true)
  expect(tab().externalMutation).toBeUndefined()

  replies.at(-1)!(disk)
  await vi.advanceTimersByTimeAsync(0)
  expect(tab().pendingDiskBaselineVerification).toBeFalsy()
  expect(tab().externalMutation).toBe(banner)
})

it('marks a dirty runtime-owned tab deleted when its host says the file is gone', async () => {
  mocks.readRuntimeFileContent.mockRejectedValue(new Error('read failed'))
  mocks.runtimePathsExist.mockResolvedValue([{ exists: false }])
  store.getState().setPendingDiskBaselineVerification(fileId, true)
  detach = attachRestoredTabConflictScan(store)
  await vi.advanceTimersByTimeAsync(0)

  expect(mocks.runtimePathsExist).toHaveBeenCalledWith(
    expect.objectContaining({ worktreePath: '/repo' }),
    [FILE],
    undefined,
    { codedAbsenceOnly: true }
  )
  expect(tab().externalMutation).toBe('deleted')
  expect(tab().pendingDiskBaselineVerification).toBeFalsy()
})

it('stops retrying and shows the conflict banner when the disk can never be checked', async () => {
  mocks.readRuntimeFileContent.mockRejectedValue(new Error('host unreachable'))
  mocks.runtimePathsExist.mockResolvedValue([{ error: 'unverifiable' }])
  store.getState().setPendingDiskBaselineVerification(fileId, true)
  detach = attachRestoredTabConflictScan(store)
  await vi.advanceTimersByTimeAsync(10 * 60_000)

  expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(MAX_VERIFY_ATTEMPTS)
  expect(tab().pendingDiskBaselineVerification).toBeFalsy()
  expect(tab().externalMutation).toBe('changed')
})

it('does not let an absence answer from before a newer check resolve that check', async () => {
  let answerProbe: (rows: unknown) => void = () => {}
  mocks.readRuntimeFileContent.mockRejectedValueOnce(new Error('read failed'))
  mocks.runtimePathsExist.mockImplementationOnce(
    () => new Promise((resolve) => (answerProbe = resolve))
  )
  store.getState().setPendingDiskBaselineVerification(fileId, true)
  detach = attachRestoredTabConflictScan(store)
  await vi.advanceTimersByTimeAsync(0)

  // The file comes back and a new catch-up asks again while the old probe is pending.
  requestRestoredTabReverification(fileId)
  mocks.readRuntimeFileContent.mockResolvedValueOnce({ content: 'v2 recreated', isBinary: false })
  answerProbe([{ exists: false }])
  await vi.advanceTimersByTimeAsync(0)

  expect(tab().externalMutation).toBe('changed')
  expect(tab().pendingDiskBaselineVerification).toBeFalsy()
})

it("forgets a tab's check requests once the tab closes", async () => {
  mocks.readRuntimeFileContent.mockResolvedValue({ content: 'v1', isBinary: false })
  detach = attachRestoredTabConflictScan(store)
  requestRestoredTabReverification(fileId)
  expect(getRestoredTabReverificationRequestCountForTest()).toBeGreaterThan(0)

  store.getState().closeFile(fileId)
  expect(getRestoredTabReverificationRequestCountForTest()).toBe(0)
})
