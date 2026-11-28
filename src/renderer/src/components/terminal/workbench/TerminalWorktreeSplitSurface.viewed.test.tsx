// @vitest-environment happy-dom
// While a shared agent's Home shows another person's tabs, this window's own panes underneath stay
// mounted but none is active: no focus, shortcut or find reaches them.
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { viewTabList } from '../../bots/teammate-tabs/viewed-tab-list'
import { WorktreeSplitSurface } from './TerminalWorktreeSplitSurface'

// What each of the window's own layers is told: whether its workspace is the active one.
const told = vi.hoisted(() => {
  const layout: boolean[] = []
  const panes: boolean[] = []
  return { layout, panes }
})
vi.mock('../../tab-group/TabGroupSplitLayout', () => ({
  default: ({ isWorktreeActive }: { isWorktreeActive: boolean }) => {
    told.layout.push(isWorktreeActive)
    return null
  }
}))
vi.mock('./WorkspacePaneOverlayLayers', () => ({
  WorkspacePaneOverlayLayers: ({ isVisible }: { isVisible: boolean }) => {
    told.panes.push(isVisible)
    return null
  }
}))
vi.mock('../../bots/teammate-tabs/ViewedTabListOverlay', () => ({
  ViewedTabListOverlay: () => null
}))
vi.mock('../../browser-pane/host-guest/retention/browser-guest-paint-retention', () => ({
  useWorktreeBrowserPageIds: () => [],
  useBrowserGuestPaintRetention: () => false
}))
vi.mock('./released-layout-inputs', () => ({
  useReleasedLayoutInputs: () => ({ tabCount: 0, groups: null })
}))
vi.mock('../../tab-bar/quick-commands/quick-command-editor-presence', () => ({
  useIsQuickCommandEditorOpen: () => false
}))

const HOME = 'folder:home-1'

afterEach(() => {
  cleanup()
  viewTabList(HOME, null)
  told.layout.length = 0
  told.panes.length = 0
})

it('keeps this window’s own panes inactive under another person’s tabs, and active again after', () => {
  render(
    <WorktreeSplitSurface
      worktreeId={HOME}
      worktreePath="/home"
      layout={{ type: 'leaf', groupId: 'g1' }}
      isVisible
      shouldMeasureHiddenWorktree={false}
      prewarmStage={null}
      shouldColdParkTerminalPanes={false}
      isForceParked={false}
      activityTerminalPortals={[]}
      backgroundMountTabIds={null}
      hasPendingBackgroundMounts={false}
      activationDeferredMountTabIds={null}
    />
  )
  expect([told.layout.at(-1), told.panes.at(-1)]).toEqual([true, true])
  act(() => viewTabList(HOME, { accountId: 'acc-mate' }))
  expect([told.layout.at(-1), told.panes.at(-1)]).toEqual([false, false])
  act(() => viewTabList(HOME, null))
  expect([told.layout.at(-1), told.panes.at(-1)]).toEqual([true, true])
})
