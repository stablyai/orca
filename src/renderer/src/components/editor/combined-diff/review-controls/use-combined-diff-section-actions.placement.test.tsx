// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { TabsDrawnFromMain } from '@/store/slices/tabs-drawn-from-main.test-fixture'
import {
  EDITOR_OWNER,
  EDITOR_PLACEMENT,
  seedEditorPlacementConsumers,
  drawEditorPlacementConsumers
} from '@/store/slices/editor/tabs/editor-placement-consumers.test-fixture'
import type { DiffSection } from '../../diff/sections/diff-section-types'
import { useCombinedDiffSectionActions } from './use-combined-diff-section-actions'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await original())
)
vi.mock('@/runtime/runtime-layout-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await original())
)
let main: TabsDrawnFromMain | undefined
afterEach(() => {
  cleanup()
  main?.close()
  main = undefined
})

const branch = {
  baseRef: 'main',
  compareRef: 'HEAD',
  baseOid: 'base',
  headOid: 'head',
  mergeBase: 'base',
  compareVersion: 'branch-version'
}
const commit = {
  commitOid: 'commit',
  parentOid: 'parent',
  compareRef: 'commit',
  baseRef: 'parent',
  compareVersion: 'commit-version'
}
const section: DiffSection = {
  key: 'notes.md',
  path: 'notes.md',
  status: 'modified',
  originalContent: '',
  modifiedContent: '',
  collapsed: false,
  loading: false,
  dirty: false,
  diffResult: null,
  largeDiffRenderLimit: null
}

it.each(['edit', 'branch', 'commit'] as const)(
  'opens a combined %s section in its invoking group, preserving the child owner',
  async (kind) => {
    const file = seedEditorPlacementConsumers({
      filePath: '/repo',
      relativePath: 'All Changes',
      diffSource: 'combined-all'
    })
    main = await drawEditorPlacementConsumers()
    const hook = renderHook(() =>
      useCombinedDiffSectionActions({
        activeGroupId: 'y-group',
        viewStateScopeId: 'x-source-tab',
        branchCompare: branch,
        commitCompare: commit,
        canOpenWorkspaceFileBrowserForPath: () => false,
        file,
        isAllMode: false,
        isBranchMode: kind === 'branch',
        isCommitMode: kind === 'commit',
        sections: [section],
        sectionsRef: { current: [section] },
        setSectionHeights: vi.fn(),
        setSections: vi.fn()
      })
    )
    act(() => hook.result.current.openSection(0))
    await main.settle()
    const state = useAppStore.getState()
    const opened = state.openFiles.find((entry) => entry.id !== file.id)
    expect(opened).toMatchObject({
      worktreeId: EDITOR_OWNER,
      filePath: '/repo/notes.md',
      runtimeEnvironmentId: null,
      mode: kind === 'edit' ? 'edit' : 'diff'
    })
    expect(
      state.unifiedTabsByWorktree[EDITOR_PLACEMENT]?.find((tab) => tab.entityId === opened?.id)
        ?.groupId
    ).toBe('x-source')
    expect(state.unifiedTabsByWorktree[EDITOR_OWNER]?.map((tab) => tab.id)).toEqual(['y-tab'])
  }
)

it.each(['combined-all', 'combined-branch'] as const)(
  'switches the alternate %s diff in the invoking folder group',
  async (alternate) => {
    const file = seedEditorPlacementConsumers({
      filePath: '/repo',
      relativePath: 'All Branch Changes',
      diffSource: 'combined-branch',
      combinedAlternate: { source: alternate }
    })
    main = await drawEditorPlacementConsumers()
    const hook = renderHook(() =>
      useCombinedDiffSectionActions({
        activeGroupId: 'y-group',
        viewStateScopeId: 'x-source-tab',
        branchSummary: { ...branch, changedFiles: 1, status: 'ready' },
        branchCompare: branch,
        commitCompare: null,
        canOpenWorkspaceFileBrowserForPath: () => false,
        file,
        isAllMode: false,
        isBranchMode: true,
        isCommitMode: false,
        sections: [],
        sectionsRef: { current: [] },
        setSectionHeights: vi.fn(),
        setSections: vi.fn()
      })
    )
    act(() => hook.result.current.openAlternateDiff())
    await main.settle()
    const state = useAppStore.getState()
    const opened = state.openFiles.find(
      (entry) =>
        entry.id !== file.id &&
        entry.diffSource ===
          (alternate === 'combined-all' ? 'combined-uncommitted' : 'combined-branch')
    )
    expect(opened?.worktreeId).toBe(EDITOR_OWNER)
    expect(
      state.unifiedTabsByWorktree[EDITOR_PLACEMENT]?.find((tab) => tab.entityId === opened?.id)
        ?.groupId
    ).toBe('x-source')
    expect(state.unifiedTabsByWorktree[EDITOR_OWNER]?.map((tab) => tab.id)).toEqual(['y-tab'])
  }
)
