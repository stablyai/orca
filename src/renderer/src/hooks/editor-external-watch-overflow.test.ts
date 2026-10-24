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
vi.mock('@/runtime/runtime-path-existence-batch', () => ({
  runtimePathsExist: harness.runtimePathsExist
}))
vi.mock('@/lib/file-owner-runtime-target', () => ({
  getRuntimeTargetForFileOwner: () => ({ kind: 'local' })
}))
// Why: the catalog says wt-1 (root /repo, this test's watch target) holds docs/report.md.
vi.mock('@/lib/runtime-workspace-file-route', () => ({
  findWorkspaceFileRoute: (_state: unknown, _hostId: string, absolutePath: string) =>
    absolutePath === '/repo/docs/report.md'
      ? { worktreeId: 'wt-1', relativePath: 'docs/report.md', executionHostId: 'local' }
      : null
}))
vi.mock('./editor-external-watch-disk-verification', () => ({
  scheduleDebouncedEditorExternalReload: harness.scheduleReload,
  scheduleEditorSelfMoveEchoVerification: harness.compareDirty
}))
vi.mock('@/components/editor/combined-diff/remember-view/combined-diff-view-cache', () => ({
  forgetCombinedDiffViewBodiesForWorktree: harness.forgetCombinedBodies
}))

import type { OpenFile } from '@/store/slices/editor'
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

  it('reloads clean tabs that still exist and clears stale tombstones', async () => {
    setTabs(
      tab('a.md', { externalMutation: 'deleted' }),
      tab('staged.ts', { mode: 'diff', diffSource: 'staged' })
    )
    harness.runtimePathsExist.mockResolvedValue([{ exists: true }])
    reconcileEditorTabsAfterOverflow(target, true)
    await vi.waitFor(() => expect(harness.scheduleReload).toHaveBeenCalledTimes(2))

    expect(harness.scheduleReload).toHaveBeenCalledWith(notification('staged.ts'))
    expect(harness.scheduleReload).toHaveBeenCalledWith(notification('a.md'))
    expect(setExternalMutation).toHaveBeenCalledWith('a.md', null)
    expect(harness.forgetCombinedBodies).toHaveBeenCalledWith('wt-1')
  })

  it('marks a tab deleted, keeping its content, when its file is gone on the owning host', async () => {
    setTabs(tab('gone.ts'), tab('moved.ts', { externalMutation: 'renamed' }), tab('here.ts'))
    harness.runtimePathsExist.mockResolvedValue([
      { exists: false },
      { exists: false },
      { exists: true }
    ])
    reconcileEditorTabsAfterOverflow(target, true)
    await vi.waitFor(() => expect(harness.scheduleReload).toHaveBeenCalledTimes(1))

    expect(harness.scheduleReload).toHaveBeenCalledWith(notification('here.ts'))
    expect(setExternalMutation).toHaveBeenCalledWith('gone.ts', 'deleted')
    // Why: a rename mark is kept as is rather than downgraded or cleared.
    expect(setExternalMutation).not.toHaveBeenCalledWith('moved.ts', expect.anything())
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

  it('compares dirty tabs asynchronously without reloading them', () => {
    setTabs(tab('dirty.ts', { isDirty: true, lastKnownDiskSignature: 'sig' }))
    reconcileEditorTabsAfterOverflow(target, true)

    expect(harness.compareDirty).toHaveBeenCalledWith(
      { ...target, connectionId: undefined, runtimeEnvironmentId: null },
      ['dirty.ts'],
      false,
      true
    )
    expect(setExternalMutation).not.toHaveBeenCalled()
    expect(harness.runtimePathsExist).not.toHaveBeenCalled()
    expect(harness.scheduleReload).not.toHaveBeenCalled()
  })

  it("re-reads another workspace's read-only view of the watched workspace's file", async () => {
    setTabs(
      tab('view', {
        worktreeId: 'wt-other',
        filePath: '/repo/docs/report.md',
        relativePath: '/repo/docs/report.md',
        readOnly: true
      })
    )
    harness.runtimePathsExist.mockResolvedValue([{ exists: true }])
    reconcileEditorTabsAfterOverflow(target, true)
    await vi.waitFor(() => expect(harness.scheduleReload).toHaveBeenCalledTimes(1))

    expect(harness.scheduleReload).toHaveBeenCalledWith(notification('docs/report.md'))
  })

  it('a storm overflow reloads clean tabs without probing or dropping combined bodies', () => {
    setTabs(
      tab('a.md', { externalMutation: 'deleted' }),
      tab('dirty.ts', { isDirty: true, lastKnownDiskSignature: 'sig' })
    )
    reconcileEditorTabsAfterOverflow(target, false)

    expect(harness.scheduleReload.mock.calls).toEqual([[notification('a.md')]])
    expect(setExternalMutation).toHaveBeenCalledWith('a.md', null)
    expect(harness.runtimePathsExist).not.toHaveBeenCalled()
    expect(harness.forgetCombinedBodies).not.toHaveBeenCalled()
    expect(harness.compareDirty).not.toHaveBeenCalled()
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

  it('only touches tabs of the matching runtime owner', async () => {
    setTabs(tab('local.md'), tab('runtime.md', { runtimeEnvironmentId: 'env-1' }))
    harness.runtimePathsExist.mockResolvedValue([{ exists: true }])
    reconcileEditorTabsAfterOverflow({ ...target, runtimeEnvironmentId: 'env-1' }, true)
    await vi.waitFor(() => expect(harness.scheduleReload).toHaveBeenCalledTimes(1))

    expect(harness.scheduleReload).toHaveBeenCalledWith(notification('runtime.md', 'env-1'))
    expect(harness.runtimePathsExist).toHaveBeenCalledWith(
      expect.anything(),
      ['/repo/runtime.md'],
      undefined,
      // Why: only a per-path ENOENT may mark a tab deleted, never a whole-request "not found".
      { codedAbsenceOnly: true }
    )
  })

  it('probes more tabs than one host batch allows in ordered chunks', async () => {
    const ids = Array.from({ length: 129 }, (_, index) => `f${index}.ts`)
    setTabs(...ids.map((id) => tab(id)))
    harness.runtimePathsExist.mockImplementation(async (_context: unknown, paths: string[]) =>
      // The last tab (the only one in the second chunk) is gone.
      paths.map((path) => ({ exists: path !== '/repo/f128.ts' }))
    )
    reconcileEditorTabsAfterOverflow(target, true)
    await vi.waitFor(() => expect(harness.scheduleReload).toHaveBeenCalledTimes(128))

    expect(harness.runtimePathsExist.mock.calls.map(([, paths]) => paths.length)).toEqual([128, 1])
    expect(setExternalMutation).toHaveBeenCalledWith('f128.ts', 'deleted')
    expect(harness.scheduleReload).not.toHaveBeenCalledWith(notification('f128.ts'))
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
