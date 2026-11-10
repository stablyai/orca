import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
  const state: Record<string, unknown> = { openFiles: [] }
  return {
    state,
    runtimePathsExist: vi.fn(),
    scheduleReload: vi.fn(),
    compareDirty: vi.fn(),
    forgetCombinedBodies: vi.fn()
  }
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => harness.state } }))
vi.mock('@/runtime/files/metadata/runtime-path-existence-batch', () => ({
  runtimePathsExist: harness.runtimePathsExist
}))
vi.mock('@/lib/files/access/file-owner-runtime-target', () => ({
  getRuntimeTargetForFileOwner: () => ({ kind: 'local' })
}))
vi.mock('./editor-external-watch-disk-verification', () => ({
  scheduleDebouncedEditorExternalReload: harness.scheduleReload,
  scheduleEditorSelfMoveEchoVerification: harness.compareDirty
}))
vi.mock('@/components/editor/combined-diff/remember-view/combined-diff-view-cache', () => ({
  forgetCombinedDiffViewBodiesForWorktree: harness.forgetCombinedBodies
}))

import type { OpenFile } from '@/store/slices/editor/types/open-file'
import {
  getPendingOverflowProbeCountForTest,
  reconcileEditorTabsAfterOverflow,
  supersedeOverflowProbesForBatch
} from './editor-external-watch-overflow'

const setExternalMutation = vi.fn()

function tab(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    worktreeId: 'wt-1',
    filePath: `/repo/${id}`,
    relativePath: id,
    mode: 'edit',
    isDirty: false,
    ...extra
  }
}

function setTabs(...openFiles: Record<string, unknown>[]): void {
  harness.state = { openFiles, setExternalMutation }
}

const target = { worktreeId: 'wt-1', worktreePath: '/repo' }
const notification = (relativePath: string, runtimeEnvironmentId: string | null = null) => ({
  worktreeId: 'wt-1',
  worktreePath: '/repo',
  relativePath,
  runtimeEnvironmentId
})

describe('reconcileEditorTabsAfterOverflow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    ['the probe fails', () => harness.runtimePathsExist.mockRejectedValue(new Error('offline'))],
    [
      'the host answers with an error row',
      () => harness.runtimePathsExist.mockResolvedValue([{ error: 'EACCES' }])
    ]
  ])('reloads as before when %s', async (_label, arrange) => {
    arrange()
    setTabs(tab('a.ts'))
    reconcileEditorTabsAfterOverflow(target, true)
    await vi.waitFor(() =>
      expect(harness.scheduleReload).toHaveBeenCalledWith(notification('a.ts'))
    )
    expect(setExternalMutation).not.toHaveBeenCalledWith('a.ts', 'deleted')
  })

  it('a storm overflow supersedes a pending resync probe', async () => {
    setTabs(tab('a.ts'))
    let answer: (rows: unknown) => void = () => {}
    harness.runtimePathsExist.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve))
    )
    reconcileEditorTabsAfterOverflow(target, true)
    reconcileEditorTabsAfterOverflow(target, false)
    expect(getPendingOverflowProbeCountForTest()).toBe(0)

    answer([{ exists: false }])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(setExternalMutation).not.toHaveBeenCalledWith('a.ts', 'deleted')
  })

  it('drops an older existence answer once a newer probe for the tab has answered', async () => {
    setTabs(tab('a.ts'))
    let answerFirst: (rows: unknown) => void = () => {}
    harness.runtimePathsExist
      .mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)))
      .mockResolvedValueOnce([{ exists: false }])
    reconcileEditorTabsAfterOverflow(target, true)
    reconcileEditorTabsAfterOverflow(target, true)
    await vi.waitFor(() => expect(setExternalMutation).toHaveBeenCalledWith('a.ts', 'deleted'))

    answerFirst([{ exists: true }])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(setExternalMutation).not.toHaveBeenCalledWith('a.ts', null)
    expect(harness.scheduleReload).not.toHaveBeenCalled()
  })

  it('drops a pending existence answer when a watch event for the tab arrives first', async () => {
    const touched: OpenFile = {
      id: 'a.ts',
      worktreeId: 'wt-1',
      filePath: '/repo/a.ts',
      relativePath: 'a.ts',
      language: 'typescript',
      mode: 'edit',
      isDirty: false
    }
    setTabs(touched)
    let answer: (rows: unknown) => void = () => {}
    harness.runtimePathsExist.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve))
    )
    reconcileEditorTabsAfterOverflow(target, true)
    supersedeOverflowProbesForBatch(
      {
        createOrUpdatePaths: new Map(),
        changes: [],
        deletedOpenEditors: [{ file: touched, normalizedDeletePath: '/repo/a.ts' }],
        hasCombinedDiffConsumer: false,
        matchesCreateOrUpdate: () => false,
        matchingOpenFiles: () => []
      },
      [touched]
    )
    expect(getPendingOverflowProbeCountForTest()).toBe(0)

    answer([{ exists: true }])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.scheduleReload).not.toHaveBeenCalled()
    expect(getPendingOverflowProbeCountForTest()).toBe(0)
  })

  it('leaves no probe entry behind for a tab closed while its probe was pending', async () => {
    setTabs(tab('a.ts'))
    let answer: (rows: unknown) => void = () => {}
    harness.runtimePathsExist.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve))
    )
    reconcileEditorTabsAfterOverflow(target, true)
    expect(getPendingOverflowProbeCountForTest()).toBe(1)

    setTabs()
    answer([{ exists: true }])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.scheduleReload).not.toHaveBeenCalled()
    expect(getPendingOverflowProbeCountForTest()).toBe(0)
  })
})
