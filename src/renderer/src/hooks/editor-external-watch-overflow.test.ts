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
vi.mock('@/lib/file-owner-runtime-target', () => ({
  getRuntimeTargetForFileOwner: () => ({ kind: 'local' })
}))
vi.mock('./editor-external-watch-disk-verification', () => ({
  scheduleDebouncedEditorExternalReload: harness.scheduleReload,
  scheduleEditorSelfMoveEchoVerification: harness.compareDirty
}))
vi.mock('@/components/editor/combined-diff/remember-view/combined-diff-view-cache', () => ({
  forgetCombinedDiffViewBodiesForWorktree: harness.forgetCombinedBodies
}))
import { reconcileEditorTabsAfterOverflow } from './editor-external-watch-overflow'

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

describe('reconcileEditorTabsAfterOverflow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
})
