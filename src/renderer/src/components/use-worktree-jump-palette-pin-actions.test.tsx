// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorktreeJumpPaletteSelectionActions } from './use-worktree-jump-palette-selection-actions'
import type { WorktreeJumpPaletteSelectionActions } from './use-worktree-jump-palette-selection-actions'
import type { WorktreeJumpPaletteLocalState } from './use-worktree-jump-palette-local-state'
import type { WorktreeJumpPaletteStoreState } from './use-worktree-jump-palette-store-state'
import type { WorktreeJumpPaletteQuickActions } from './use-worktree-jump-palette-quick-actions'
import type { WorktreeJumpPaletteSelectionLifecycle } from './use-worktree-jump-palette-selection-lifecycle'

const storeMock = vi.hoisted(() => ({
  pinTab: vi.fn(),
  unpinTab: vi.fn(),
  pinFile: vi.fn(),
  setWorktreesPinnedAndReveal: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        pinTab: storeMock.pinTab,
        unpinTab: storeMock.unpinTab,
        pinFile: storeMock.pinFile,
        setWorktreesPinnedAndReveal: storeMock.setWorktreesPinnedAndReveal
      }),
    {
      getState: () => ({
        getKnownWorktreeById: () => null
      })
    }
  )
}))

let latest: WorktreeJumpPaletteSelectionActions | null = null
let root: Root
let container: HTMLDivElement

type StubBuildQuickActionContext = WorktreeJumpPaletteQuickActions['buildQuickActionContext']
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only invoked by handleSelectQuickAction, unused here.
const stubBuildQuickActionContext = vi.fn() as unknown as StubBuildQuickActionContext

function Harness(): null {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook only reads the fields this harness stubs.
  latest = useWorktreeJumpPaletteSelectionActions({
    closeModal: vi.fn(),
    recordFeatureInteraction: vi.fn(),
    skipRestoreFocusRef: { current: false },
    setSelectedItemId: vi.fn(),
    focusFallbackSurface: vi.fn(),
    requestBrowserFocus: vi.fn(),
    openSettingsTarget: vi.fn(),
    openSettingsPage: vi.fn(),
    buildQuickActionContext: stubBuildQuickActionContext,
    revealSidebarRow: vi.fn(),
    previousActiveTabTypeRef: { current: null },
    previousBrowserPageIdRef: { current: null },
    previousBrowserFocusTargetRef: { current: null },
    previousWorktreeIdRef: { current: null },
    previousFocusElementRef: { current: null }
  } as unknown as WorktreeJumpPaletteStoreState &
    WorktreeJumpPaletteLocalState &
    Pick<WorktreeJumpPaletteQuickActions, 'buildQuickActionContext'> &
    Pick<WorktreeJumpPaletteSelectionLifecycle, 'focusFallbackSurface' | 'requestBrowserFocus'>)
  return null
}

beforeEach(() => {
  storeMock.pinTab.mockReset()
  storeMock.unpinTab.mockReset()
  storeMock.pinFile.mockReset()
  storeMock.setWorktreesPinnedAndReveal.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<Harness />)
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  latest = null
})

describe('useWorktreeJumpPaletteSelectionActions pin toggles', () => {
  it('calls the real pinTab store action when toggling an unpinned terminal tab', () => {
    latest?.handleToggleWorkspaceTabPinned('tab-1', false, 'term-1', 'terminal')

    expect(storeMock.pinTab).toHaveBeenCalledWith('tab-1')
    expect(storeMock.unpinTab).not.toHaveBeenCalled()
    expect(storeMock.pinFile).not.toHaveBeenCalled()
  })

  it('calls the real unpinTab store action when toggling a pinned terminal tab', () => {
    latest?.handleToggleWorkspaceTabPinned('tab-1', true, 'term-1', 'terminal')

    expect(storeMock.unpinTab).toHaveBeenCalledWith('tab-1')
    expect(storeMock.pinTab).not.toHaveBeenCalled()
    expect(storeMock.pinFile).not.toHaveBeenCalled()
  })

  it('calls pinFile (not bare pinTab) when pinning an unpinned editor tab, matching TabBar.tsx', () => {
    latest?.handleToggleWorkspaceTabPinned('tab-2', false, 'file-1', 'editor')

    expect(storeMock.pinFile).toHaveBeenCalledWith('file-1', 'tab-2')
    expect(storeMock.pinTab).not.toHaveBeenCalled()
    expect(storeMock.unpinTab).not.toHaveBeenCalled()
  })

  it('still calls plain unpinTab when unpinning a pinned editor tab', () => {
    latest?.handleToggleWorkspaceTabPinned('tab-2', true, 'file-1', 'editor')

    expect(storeMock.unpinTab).toHaveBeenCalledWith('tab-2')
    expect(storeMock.pinFile).not.toHaveBeenCalled()
    expect(storeMock.pinTab).not.toHaveBeenCalled()
  })

  it('calls setWorktreesPinnedAndReveal with the flipped state for a single worktree', () => {
    latest?.handleToggleWorktreePinned('wt-1', false)

    expect(storeMock.setWorktreesPinnedAndReveal).toHaveBeenCalledWith(['wt-1'], true)
  })

  it('flips back to unpinned when the worktree is already pinned', () => {
    latest?.handleToggleWorktreePinned('wt-1', true)

    expect(storeMock.setWorktreesPinnedAndReveal).toHaveBeenCalledWith(['wt-1'], false)
  })
})
