// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '@/store/types'
import {
  createWorkspaceCleanupBrowseSlice,
  resetWorkspaceCleanupBrowsePersistTimer
} from '@/store/slices/workspace-cleanup/workspace-cleanup-browse'
import { createDefaultWorkspaceCleanupBrowseState } from '../../../../../shared/workspace-cleanup/workspace-cleanup-browse-state'

import {
  useWorkspaceCleanupBrowseState,
  type WorkspaceCleanupBrowseController
} from './use-workspace-cleanup-browse-state'

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
})
