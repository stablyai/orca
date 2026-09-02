// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '@/store/types'
import {
  createWorkspaceCleanupBrowseSlice,
  resetWorkspaceCleanupBrowsePersistTimer
} from '@/store/slices/workspace-cleanup-browse'
import { createDefaultWorkspaceCleanupBrowseState } from '../../../../shared/workspace-cleanup-browse-state'
import { listAppliedWorkspaceCleanupFilters } from '../../../../shared/workspace-cleanup-applied-filters'
import { useWorkspaceCleanupBrowseState } from './use-workspace-cleanup-browse-state'
import type { WorkspaceCleanupBrowseController } from './use-workspace-cleanup-browse-state'

const store = create<AppState>()(
  (...a) =>
    ({
      workspaceCleanupDismissals: {},
      ...createWorkspaceCleanupBrowseSlice(...a)
    }) as unknown as AppState
)

vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: AppState) => T): T => store(selector)
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

function mountController(): { current: WorkspaceCleanupBrowseController | null } {
  const ref: { current: WorkspaceCleanupBrowseController | null } = { current: null }
  function Probe(): null {
    ref.current = useWorkspaceCleanupBrowseState()
    return null
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<Probe />))
  return ref
}

describe('useWorkspaceCleanupBrowseState', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ;(globalThis as { window: unknown }).window = {
      ...globalThis.window,
      api: { ui: { set: vi.fn().mockResolvedValue(undefined) } }
    }
    store.setState({
      workspaceCleanupBrowse: createDefaultWorkspaceCleanupBrowseState()
    } as Partial<AppState>)
  })

  afterEach(() => {
    if (root) {
      act(() => root!.unmount())
    }
    root = null
    container = null
    document.body.replaceChildren()
    resetWorkspaceCleanupBrowsePersistTimer()
    vi.useRealTimers()
  })

  it('keeps both patches when two groups are written in one tick', () => {
    const controller = mountController()

    // Why one act(): a checkbox toggle writes several groups at once. Reading the
    // rendered `browse` snapshot per call would make the second patch overwrite
    // the first, which is what this asserts against.
    act(() => {
      controller.current!.patchFilters('activity', { idleMinDays: 20 })
      controller.current!.patchFilters('size', { maxBytes: 500 })
    })

    const filters = store.getState().workspaceCleanupBrowse.filters
    expect(filters.activity.idleMinDays).toBe(20)
    expect(filters.size.maxBytes).toBe(500)
  })

  it('keeps both patches when the same group is written twice in one tick', () => {
    const controller = mountController()

    act(() => {
      controller.current!.patchFilters('git', { minAhead: 2 })
      controller.current!.patchFilters('git', { branchQuery: 'release' })
    })

    const git = store.getState().workspaceCleanupBrowse.filters.git
    expect(git.minAhead).toBe(2)
    expect(git.branchQuery).toBe('release')
  })

  it('flips sort direction against the latest state, not the rendered snapshot', () => {
    const controller = mountController()

    act(() => {
      controller.current!.toggleSortField('size')
      controller.current!.toggleSortField('size')
    })

    expect(store.getState().workspaceCleanupBrowse.sort).toEqual({
      field: 'size',
      direction: 'desc'
    })
  })

  it('keeps a cleared chip cleared when a facet patch lands in the same tick', () => {
    const controller = mountController()
    act(() => controller.current!.patchFilters('activity', { idleMinDays: 20 }))

    const format = new Proxy({}, { get: () => () => 'chip' }) as Parameters<
      typeof listAppliedWorkspaceCleanupFilters
    >[1]
    const chip = listAppliedWorkspaceCleanupFilters(
      store.getState().workspaceCleanupBrowse.filters,
      format
    ).find((a) => a.id === 'activity.idleMinDays')!

    act(() => {
      controller.current!.replaceFilters(chip.clear)
      controller.current!.patchFilters('git', { states: ['dirty'] })
    })

    const filters = store.getState().workspaceCleanupBrowse.filters
    expect(filters.activity.idleMinDays).toBeNull()
    expect(filters.git.states).toEqual(['dirty'])
  })
})
