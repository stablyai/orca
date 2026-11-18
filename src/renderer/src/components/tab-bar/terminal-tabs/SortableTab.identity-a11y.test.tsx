// @vitest-environment happy-dom

import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { TabDragItemData } from '../../tab-group/drag/tab-drag-data'
import SortableTab from './SortableTab'

vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  return {
    useAppStore: create(() => ({
      unreadTerminalTabs: {},
      unreadAgentCompletionPanes: {},
      agentStatusByPaneKey: acceptedAgentStatuses(),
      agentStatusEpoch: 0,
      runtimePaneTitlesByTabId: {},
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {},
      keybindings: {}
    }))
  }
})
vi.mock('./SortableTabContextMenu', () => ({ SortableTabContextMenu: () => null }))
vi.mock('../../terminal/shells/ShellIcon', () => ({ ShellIcon: () => <span /> }))
vi.mock('@/lib/agent-catalog/agent-catalog', () => ({
  AgentIcon: () => <span />,
  getAgentLabel: (agent: string) => agent
}))

const dragData: TabDragItemData = {
  kind: 'tab',
  worktreeId: 'wt-1',
  groupId: 'group-1',
  unifiedTabId: 'room-tab',
  visibleTabId: 'room-tab',
  tabType: 'room',
  label: 'triage team'
}

function renderRoomTab(
  identityDetail: string | undefined,
  tabDragData: TabDragItemData = dragData
): void {
  render(
    <TooltipProvider>
      <DndContext>
        <SortableContext items={['room-tab']}>
          <SortableTab
            tab={{
              id: 'room-tab',
              worktreeId: 'wt-1',
              title: 'triage team',
              customTitle: null,
              color: null
            }}
            agent={null}
            unifiedTabId="room-tab"
            groupId="group-1"
            tabCount={1}
            hasTabsToRight={false}
            hasTabsToLeft={false}
            isActive
            isPinned={false}
            isExpanded={false}
            onActivate={vi.fn()}
            onClose={vi.fn()}
            onCloseOthers={vi.fn()}
            onCloseToRight={vi.fn()}
            onCloseToLeft={vi.fn()}
            onSetCustomTitle={vi.fn()}
            onSetTabColor={vi.fn()}
            onTogglePin={vi.fn()}
            onToggleExpand={vi.fn()}
            dragData={tabDragData}
            dropIndicator={null}
            identityIcon={<span />}
            identityDetail={identityDetail}
          />
        </SortableContext>
      </DndContext>
    </TooltipProvider>
  )
}

afterEach(cleanup)

describe('SortableTab identity detail', () => {
  it('names who the icon stands for in the tab, keeping the drag instructions', () => {
    renderRoomTab('Scout, Juno, Pip')
    const tab = screen.getByTestId('sortable-tab')
    expect(tab.getAttribute('aria-label')).toBe('triage team, Scout, Juno, Pip')
    const describedBy = tab.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy ?? '')?.textContent).toMatch(/draggable/)
  })

  it('leaves a tab without identity detail named by its content', () => {
    renderRoomTab(undefined)
    expect(screen.getByTestId('sortable-tab').hasAttribute('aria-label')).toBe(false)
  })

  it('keeps a pinned-first tab that cannot be dragged announced as available', () => {
    renderRoomTab('Home', { ...dragData, fixedFirst: true })
    expect(screen.getByTestId('sortable-tab').hasAttribute('aria-disabled')).toBe(false)
  })
})
