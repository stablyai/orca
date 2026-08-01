// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { GlobalSettings, TerminalTab } from '../../../../shared/types'

let settings: Partial<GlobalSettings> | null = null
let agentStatusByPaneKey: Record<string, AgentStatusEntry> = {}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      agentStatusByPaneKey,
      agentStatusEpoch: 0,
      keybindings: {},
      ptyIdsByTabId: {},
      renamingTabId: null,
      runtimePaneTitlesByTabId: {},
      setRenamingTabId: vi.fn(),
      settings,
      terminalLayoutsByTabId: {},
      unreadAgentCompletionPanes: {},
      unreadTerminalTabs: {}
    })
}))

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn() })
}))

vi.mock('@/lib/use-tab-agent', () => ({
  useTabAgent: () => null
}))

vi.mock('./SortableTabContextMenu', () => ({
  SortableTabContextMenu: () => null
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div data-tooltip-content="">{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

import SortableTab from './SortableTab'

const LEAF_A = '11111111-1111-4111-8111-111111111111'

function makeTab(): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'agent terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function entry(usedTokens: number): AgentStatusEntry {
  return {
    paneKey: `tab-1:${LEAF_A}`,
    state: 'working',
    prompt: 'fill the window',
    updatedAt: 1_000,
    stateStartedAt: 1_000,
    stateHistory: [],
    agentType: 'claude',
    model: 'claude-sonnet-4-5',
    contextUsage: { usedTokens, maxTokens: 200_000 }
  }
}

function renderTab(): HTMLElement {
  return render(
    <SortableTab
      tab={makeTab()}
      unifiedTabId="unified-1"
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
      dragData={{ type: 'tab', tabId: 'tab-1', groupId: 'group-1' } as never}
    />
  ).container
}

describe('SortableTab context pressure', () => {
  afterEach(() => {
    cleanup()
    settings = null
    agentStatusByPaneKey = {}
  })

  it('shows the worst-of pane dot at warning/critical', () => {
    settings = { experimentalContextPressure: true }
    agentStatusByPaneKey = { [`tab-1:${LEAF_A}`]: entry(195_000) }

    expect(renderTab().querySelector('[data-context-pressure="critical"]')).not.toBeNull()
  })

  it("stays quiet at 'ok' — the tab strip is an aggregate surface", () => {
    settings = { experimentalContextPressure: true }
    agentStatusByPaneKey = { [`tab-1:${LEAF_A}`]: entry(100_000) }

    expect(renderTab().querySelector('[data-context-pressure]')).toBeNull()
  })

  it('renders nothing while the experimental flag is off', () => {
    settings = null
    agentStatusByPaneKey = { [`tab-1:${LEAF_A}`]: entry(195_000) }

    expect(renderTab().querySelector('[data-context-pressure]')).toBeNull()
  })
})
