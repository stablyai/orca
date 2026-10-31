// @vitest-environment happy-dom

import type { ReactElement, ReactNode } from 'react'
import { cloneElement, isValidElement, StrictMode } from 'react'
import { act, render, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TabDragItemData } from '../tab-group/useTabDragSplit'
import { useAppStore } from '../../store'
import SortableTab from './SortableTab'
import { ContextMenuContent } from '../ui/context-menu'
import { requestTerminalTabRename } from './terminal-tab-rename-request'

type ProbeState = {
  unreadTerminalTabs: Record<string, boolean>
  unreadAgentCompletionPanes: Record<string, boolean>
  agentStatusByPaneKey: Record<string, unknown>
  agentStatusEpoch: number
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  ptyIdsByTabId: Record<string, string[]>
  terminalLayoutsByTabId: Record<string, unknown>
  keybindings: Record<string, unknown>
}

type StoreApiWithHook = {
  (selector: (state: ProbeState) => unknown): unknown
  getState: () => ProbeState
  setState: (partial: Partial<ProbeState>) => void
}

// Both specifiers resolve to the same store module; memoize so they share one instance.
async function createProbeStore(): Promise<StoreApiWithHook> {
  const globalKey = '__sortableTabProbeStore'
  const globals = globalThis as Record<string, unknown>
  if (!globals[globalKey]) {
    const { create } = await import('zustand')
    globals[globalKey] = create<ProbeState>(() => ({
      unreadTerminalTabs: {},
      unreadAgentCompletionPanes: {},
      agentStatusByPaneKey: {},
      agentStatusEpoch: 0,
      runtimePaneTitlesByTabId: {},
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {},
      keybindings: {}
    }))
  }
  return globals[globalKey] as StoreApiWithHook
}

vi.mock('@/store', async () => ({ useAppStore: await createProbeStore() }))
vi.mock('../../store', async () => ({ useAppStore: await createProbeStore() }))

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: ({ id }: { id: string }) => ({
    attributes: { role: 'tab', 'data-sortable-id': id },
    listeners: { onPointerDown: vi.fn() },
    setNodeRef: vi.fn()
  })
}))

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children, asChild }: { children: ReactNode; asChild?: boolean }) =>
    asChild && isValidElement(children) ? (
      cloneElement(children as ReactElement<Record<string, unknown>>)
    ) : (
      <span>{children}</span>
    )
}))

vi.mock('@/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />
}))

// Count this unconditional child because the harness counter cannot observe internal SortableTab renders.
vi.mock('./TerminalTabLeadingIcon', () => ({
  TerminalTabLeadingIcon: () => {
    tabRenderCount += 1
    return <span />
  }
}))

const menuCompletions: (() => void)[] = []
vi.mock('./SortableTabContextMenu', () => ({
  SortableTabContextMenu: ({
    onSessionSwitchComplete
  }: {
    onSessionSwitchComplete: () => void
  }) => {
    menuCompletions.push(onSessionSwitchComplete)
    return (
      <ContextMenuContent>
        <div data-testid="open-menu" />
      </ContextMenuContent>
    )
  }
}))

vi.mock('./shell-icons', () => ({ ShellIcon: () => <span /> }))
vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => <span />,
  getAgentLabel: (agent: string) => agent
}))
vi.mock('../sidebar/WorktreeCardHelpers', () => ({ FilledBellIcon: () => <span /> }))

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'terminal-tab-1',
    title: 'Terminal 1',
    worktreeId: 'wt-1',
    ...overrides
  } as TerminalTab
}

const dragData: TabDragItemData = {
  kind: 'tab',
  worktreeId: 'wt-1',
  groupId: 'group-1',
  unifiedTabId: 'unified-1',
  visibleTabId: 'terminal-tab-1',
  tabType: 'terminal',
  label: 'Terminal 1'
}

const probeStore = useAppStore as unknown as StoreApiWithHook

let renderCount = 0
let tabRenderCount = 0

function Harness({ tab }: { tab: TerminalTab }): ReactElement {
  renderCount += 1
  return (
    <SortableTab
      tab={tab}
      agent={null}
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
      // A fresh object per render, exactly like renderTabBarItems builds it.
      dragData={{ ...dragData }}
      dropIndicator={null}
    />
  )
}

afterEach(() => {
  cleanup()
  probeStore.setState({ unreadTerminalTabs: {}, agentStatusEpoch: 0 })
  renderCount = 0
  tabRenderCount = 0
})

describe('SortableTab update-depth probe', () => {
  it('settles when the rename shortcut targets this tab', () => {
    const { container } = render(<Harness tab={makeTab()} />)
    act(() => requestTerminalTabRename('terminal-tab-1'))
    expect(container.querySelector('[data-tab-rename-input]')).not.toBeNull()
    expect(renderCount).toBeLessThan(20)
  })

  // Address rename requests to one tab instead of broadcasting two store-driven renders to every tab.
  it('re-renders only the targeted tab, once, per rename request', () => {
    render(
      <>
        <Harness tab={makeTab({ id: 'terminal-tab-1' })} />
        <Harness tab={makeTab({ id: 'terminal-tab-2' })} />
        <Harness tab={makeTab({ id: 'terminal-tab-3' })} />
      </>
    )
    const mountRenders = tabRenderCount
    act(() => requestTerminalTabRename('terminal-tab-1'))
    expect(tabRenderCount - mountRenders).toBe(1)
  })

  it('does not re-render any tab for a rename request no mounted tab owns', () => {
    render(
      <>
        <Harness tab={makeTab({ id: 'terminal-tab-1' })} />
        <Harness tab={makeTab({ id: 'terminal-tab-2' })} />
      </>
    )
    const mountRenders = tabRenderCount
    act(() => requestTerminalTabRename('terminal-tab-9'))
    expect(tabRenderCount).toBe(mountRenders)
  })

  it('settles in StrictMode double-invoked effects', () => {
    const { container } = render(
      <StrictMode>
        <Harness tab={makeTab()} />
      </StrictMode>
    )
    act(() => requestTerminalTabRename('terminal-tab-1'))
    expect(container.querySelector('[data-tab-rename-input]')).not.toBeNull()
  })
})

it('retires completion ownership for repeated gestures and batched blur/reopen', () => {
  const { container } = render(<Harness tab={makeTab()} />)
  const slot = container.querySelector('[data-tab-strip-slot]')!
  act(() => fireEvent.contextMenu(slot))
  const first = menuCompletions.at(-1)!
  act(() => fireEvent.contextMenu(slot))
  act(first)
  expect(screen.queryByTestId('open-menu')).not.toBeNull()
  const second = menuCompletions.at(-1)!
  act(() => {
    window.dispatchEvent(new Event('blur'))
    fireEvent.contextMenu(slot)
  })
  act(second)
  expect(screen.queryByTestId('open-menu')).not.toBeNull()
  act(menuCompletions.at(-1)!)
  expect(screen.queryByTestId('open-menu')).toBeNull()
})
