// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = {
    activeWorktreeId: 'wt-a',
    rightSidebarOpen: true,
    sidebarOpen: true,
    groupsByWorktree: {}
  }
  const useAppStore = (selector: (current: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})
vi.mock('@/store', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('../../store', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('../tab-bar/TabBar', () => ({ default: () => null }))
vi.mock('../tab-bar/TabBarQuickCommandsButton', () => ({
  TabBarQuickCommandsButton: () => null
}))
vi.mock('@/lib/pane-manager/client-hosted-browser-row-state', () => ({
  useClientHostedBrowserRows: () => []
}))
vi.mock('./useTabGroupWorkspaceModel', () => ({
  useTabGroupWorkspaceModel: () => ({
    activeTab: { id: 'tab-1', entityId: 'term-1', contentType: 'terminal' },
    agentSessionItems: [],
    browserItems: [],
    commands: { focusGroup: () => undefined, closeGroup: () => undefined },
    editorItems: [],
    tabBarOrder: [],
    terminalTabs: [],
    groupTabs: [],
    expandedPaneByTabId: {}
  })
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import TabGroupPanel from './TabGroupPanel'

function panel(isFocused: boolean): React.JSX.Element {
  return (
    <TooltipProvider>
      <TabGroupPanel
        groupId="group-a"
        worktreeId="wt-a"
        isVisible
        isFocused={isFocused}
        hasSplitGroups
        touchesLeftEdge={false}
        touchesRightEdge={false}
        reserveClosedExplorerToggleSpace={false}
        reserveCollapsedSidebarHeaderSpace={false}
      />
    </TooltipProvider>
  )
}

afterEach(cleanup)

describe('TabGroupPanel Pane Actions menu', () => {
  it('closes without restoring focus to the old group', async () => {
    const view = render(panel(true))
    const trigger = view.getByRole('button', { name: 'Pane Actions' })
    act(() => {
      fireEvent.pointerDown(trigger, {
        button: 0,
        ctrlKey: false,
        pointerType: 'mouse'
      })
    })
    expect(view.queryByRole('menuitem', { name: 'Close split pane' })).not.toBeNull()

    await act(async () => {
      view.rerender(panel(false))
      // Radix restores trigger focus on the next task after its focus scope unmounts.
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(view.queryByRole('menuitem', { name: 'Close split pane' })).toBeNull()
    expect(document.activeElement).not.toBe(trigger)

    view.rerender(panel(true))
    expect(view.queryByRole('menuitem', { name: 'Close split pane' })).toBeNull()
  })
})
