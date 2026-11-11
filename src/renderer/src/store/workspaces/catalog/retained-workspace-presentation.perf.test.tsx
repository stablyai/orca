// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'
import { makeAgentEntry } from '@/components/worktree-jump/worktree-jump-palette-test-fixtures'
import { replaceRecordEntries } from '@/store/keyed-record-transitions'
import { getIndexedWorktreeMap } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/workspace/ownership/resolved-worktree-execution-host'
import {
  createWorkspacePresentationSelector,
  selectWorkspacePresentationWorktrees
} from './retained-workspace-presentation'
import type { Worktree } from '../../../../../shared/worktree/types'
import type * as PaletteRepoResolution from '@/lib/workspace/search/palette-repo-resolution'
import { useWorktreeJumpPaletteStoreState } from '@/components/worktree-jump/use-worktree-jump-palette-store-state'

vi.mock('../../../../../shared/sidebar-inputs-switch', () => ({
  ORCA_SIDEBAR_INPUTS_IS_MAIN: false
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: vi.fn(async () => undefined)
}))

const { dedupeRows } = vi.hoisted(() => ({ dedupeRows: vi.fn() }))
vi.mock('@/lib/workspace/search/palette-repo-resolution', async (importOriginal) => {
  const actual = await importOriginal<typeof PaletteRepoResolution>()
  return {
    ...actual,
    dedupePaletteWorktrees: (rows: Worktree[]) => {
      dedupeRows(rows.length)
      return actual.dedupePaletteWorktrees(rows)
    }
  }
})
vi.mock('@/hooks/useSettingsNavigationMetadata', () => ({
  useSettingsNavigationMetadata: () => []
}))
vi.mock('@/store/plugins/catalog/plugin-contribution-catalog', () => ({
  usePluginCommands: () => []
}))
vi.mock('@/store/plugins/file-creation/plugin-new-files', () => ({
  usePluginNewFiles: () => []
}))

const initialState = useAppStore.getInitialState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

it.each([100, 1000])(
  'bounds addressed membership work and unaffected pane renders with %i workspaces',
  (count) => {
    const rows = Array.from({ length: count }, (_, index) =>
      makeWorktree({
        id: `repo::/${index}/.bare`,
        repoId: `repo-${index}`,
        path: `/${index}/.bare`,
        isBare: true,
        hostId: index % 2 ? 'runtime:other' : 'local',
        runtimeOwnerEnvironmentId: index % 2 ? 'other' : undefined
      })
    )
    const [target, otherHost, empty] = rows
    useAppStore.setState(
      {
        ...initialState,
        worktreesByRepo: {},
        detectedWorktreesByRepo: Object.fromEntries(
          rows.map((row) => [
            row.repoId,
            {
              repoId: row.repoId,
              source: 'git' as const,
              authoritative: true,
              worktrees: [
                { ...row, ownership: 'external' as const, selectedCheckout: false, visible: false }
              ]
            }
          ])
        ),
        tabsByWorktree: Object.fromEntries(
          rows
            .filter((row) => row !== empty)
            .map((row) => [row.id, [makeTab({ id: row.id, worktreeId: row.id })]])
        )
      },
      true
    )
    const inspected: string[] = []
    const inspectedContent: string[] = []
    const selectPresentation = createWorkspacePresentationSelector<Worktree>({
      onInspectBucket: (id) => inspected.push(id),
      onInspectContent: (id) => inspectedContent.push(id)
    })
    let targetRenders = 0
    let otherRenders = 0
    let emptyRenders = 0
    const targetPane = renderHook(() => {
      targetRenders++
      return useAppStore((state) => selectPresentation(state)[target.repoId])
    })
    const otherPane = renderHook(() => {
      otherRenders++
      return useAppStore((state) => selectPresentation(state)[otherHost.repoId])
    })
    const newPane = renderHook(() => {
      emptyRenders++
      return useAppStore((state) => selectPresentation(state)[empty.repoId])
    })
    const before = selectPresentation(useAppStore.getState())
    targetRenders = otherRenders = emptyRenders = 0
    inspected.length = 0
    inspectedContent.length = 0
    act(() => {
      useAppStore.setState((state) => ({
        tabsByWorktree: replaceRecordEntries(state.tabsByWorktree, [
          [
            target.id,
            state.tabsByWorktree[target.id].map((tab) => ({ ...tab, title: 'Updated title' }))
          ]
        ])
      }))
    })
    // A title changes one bucket, never membership: work is independent of fleet size.
    expect(inspected).toEqual([target.id])
    expect(inspectedContent).toEqual([target.id])
    expect(selectPresentation(useAppStore.getState())).toBe(before)
    expect([targetRenders, otherRenders, emptyRenders]).toEqual([0, 0, 0])
    expect(targetPane.result.current).toBe(before[target.repoId])
    expect(otherPane.result.current).toBe(before[otherHost.repoId])
    inspected.length = 0
    inspectedContent.length = 0
    act(() => {
      useAppStore.setState({
        agentStatusByPaneKey: { changed: makeAgentEntry('target-tab', 'working', 1) }
      })
    })
    expect(inspected).toEqual([])
    expect(inspectedContent).toEqual([])
    expect([targetRenders, otherRenders, emptyRenders]).toEqual([0, 0, 0])
    act(() => {
      useAppStore.setState((state) => ({
        tabsByWorktree: replaceRecordEntries(state.tabsByWorktree, [
          [empty.id, [makeTab({ id: 'new-shell', worktreeId: empty.id })]]
        ])
      }))
    })
    expect(inspected).toEqual([empty.id])
    expect(inspectedContent).toEqual([empty.id])
    expect([targetRenders, otherRenders, emptyRenders]).toEqual([0, 0, 1])
    expect(newPane.result.current?.map((row) => row.id)).toEqual(['repo::/2/.bare'])
  }
)

it.each([100, 1000])(
  'reuses raw catalog indexes and reconciles only the activity owner among %i repos',
  (count) => {
    const rows = Array.from({ length: count }, (_, index) =>
      makeWorktree({
        id: `repo-${index}::/checkout`,
        repoId: `repo-${index}`,
        path: `/checkout-${index}`,
        hostId: 'local'
      })
    )
    const hidden = rows.map((row) => ({
      ...row,
      id: `${row.repoId}::/.bare`,
      path: '/.bare',
      isBare: true
    }))
    useAppStore.setState(
      {
        ...initialState,
        repos: rows.map((row) => ({
          id: row.repoId,
          path: row.path,
          displayName: 'Repo',
          badgeColor: '',
          addedAt: 0,
          executionHostId: 'local'
        })),
        worktreesByRepo: Object.fromEntries(rows.map((row) => [row.repoId, [row]])),
        detectedWorktreesByRepo: Object.fromEntries(
          rows.map((row, index) => [
            row.repoId,
            {
              repoId: row.repoId,
              source: 'git' as const,
              authoritative: true,
              worktrees: [row, hidden[index]].map((value) => ({
                ...value,
                ownership: 'external' as const,
                selectedCheckout: !value.isBare,
                visible: !value.isBare
              }))
            }
          ])
        ),
        tabsByWorktree: Object.fromEntries(
          rows.map((row) => [row.id, [makeTab({ id: row.repoId, worktreeId: row.id })]])
        )
      },
      true
    )
    const inspected: string[] = []
    const selectPresentation = createWorkspacePresentationSelector<Worktree>({
      onInspectDetectedRow: (id) => inspected.push(id)
    })
    renderHook(() => useAppStore(selectPresentation))
    const original = useAppStore.getState()
    expect(selectPresentation(original)).toBe(original.worktreesByRepo)
    inspected.length = 0
    act(() => {
      useAppStore.getState().bumpWorktreeActivity(rows[0].id)
    })
    const updated = useAppStore.getState()
    expect(updated.worktreesByRepo['repo-0'][0].lastActivityAt).toBeGreaterThan(0)
    // The writer changes two rows in one repo; unrelated detection must never be visited.
    expect(inspected).toEqual(['repo-0::/checkout', 'repo-0::/.bare'])
    expect(selectPresentation(updated)).toBe(updated.worktreesByRepo)
    const projected = selectWorkspacePresentationWorktrees(updated)
    expect(projected).toBe(updated.worktreesByRepo)
    expect(getIndexedWorktreeMap(projected)).toBe(getIndexedWorktreeMap(updated.worktreesByRepo))
    expect(getResolvedExecutionHostIdForWorktree(updated, rows[0].id)).toBe('local')
    inspected.length = 0
    act(() => {
      useAppStore.setState((state) => ({
        worktreesByRepo: replaceRecordEntries<Worktree[]>(state.worktreesByRepo, [
          ['repo-0', state.worktreesByRepo['repo-0'].map((row) => ({ ...row, isUnread: true }))]
        ])
      }))
    })
    expect(inspected).toEqual([])
    expect(selectPresentation(useAppStore.getState())).toBe(useAppStore.getState().worktreesByRepo)
  }
)

it.each([100, 1000])(
  'adds no closed-palette listing work after an activity write among %i workspaces',
  (count) => {
    const rows = Array.from({ length: count }, (_, index) =>
      makeWorktree({ id: `repo-${index}::/checkout`, repoId: `repo-${index}`, hostId: 'local' })
    )
    const hidden = makeWorktree({
      id: 'repo-0::/.bare',
      repoId: 'repo-0',
      hostId: 'local',
      isBare: true
    })
    useAppStore.setState(
      {
        ...initialState,
        worktreesByRepo: Object.fromEntries(rows.map((row) => [row.repoId, [row]])),
        detectedWorktreesByRepo: {
          'repo-0': {
            repoId: 'repo-0',
            source: 'git',
            authoritative: true,
            worktrees: [
              { ...hidden, ownership: 'external', selectedCheckout: false, visible: false }
            ]
          }
        },
        tabsByWorktree: { [hidden.id]: [makeTab({ id: 'saved-shell', worktreeId: hidden.id })] }
      },
      true
    )
    const palette = renderHook(
      ({ visible }) => useWorktreeJumpPaletteStoreState({ visible, lingering: false }),
      {
        initialProps: { visible: true }
      }
    )
    expect(palette.result.current.presentationWorkspaces.some((row) => row.id === hidden.id)).toBe(
      true
    )
    palette.rerender({ visible: false })
    dedupeRows.mockClear()
    act(() => {
      useAppStore.getState().bumpWorktreeActivity(rows[0].id)
    })
    // Only the pre-existing checkout list may run while closed; retained search has no output.
    expect(dedupeRows.mock.calls).toEqual([[count]])
    expect(palette.result.current.presentationWorkspaces).toEqual([])
    palette.rerender({ visible: true })
    expect(palette.result.current.presentationWorkspaces.some((row) => row.id === hidden.id)).toBe(
      true
    )
    act(() => {
      useAppStore.setState((state) => ({
        tabsByWorktree: replaceRecordEntries<AppState['tabsByWorktree'][string]>(
          state.tabsByWorktree,
          [[hidden.id, null]]
        )
      }))
    })
    expect(palette.result.current.presentationWorkspaces).toBe(palette.result.current.workspaces)
  }
)
