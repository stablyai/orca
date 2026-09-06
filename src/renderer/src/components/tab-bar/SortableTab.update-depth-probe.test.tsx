// @vitest-environment happy-dom

/**
 * Pins the settling guarantee for every setState-in-effect path SortableTab owns
 * (rename shortcut, title churn mid-rename, store write storms, StrictMode double
 * invoke) under a real React root, where "Maximum update depth exceeded" throws.
 *
 * Written while triaging the React #185 crash cluster whose component_stack names
 * SortableTab: these paths settle, which matches shared/react-update-depth-attribution.ts
 * — #185 lands on whichever fiber dispatched next after a root-global counter tripped,
 * so that stack names a bystander. Keep this green so the tab stays exonerated.
 */
import type { ReactElement, ReactNode } from 'react'
import { cloneElement, isValidElement, StrictMode, useEffect, useState } from 'react'
import { act, render, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TabDragItemData } from '../tab-group/useTabDragSplit'
import { useAppStore } from '../../store'
import SortableTab from './SortableTab'
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

vi.mock('@/lib/use-tab-agent', () => ({ useTabAgent: () => null }))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children, asChild }: { children: ReactNode; asChild?: boolean }) =>
    asChild && isValidElement(children) ? (
      cloneElement(children as ReactElement<Record<string, unknown>>)
    ) : (
      <span>{children}</span>
    )
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: () => null,
  DropdownMenuItem: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuSeparator: () => null,
  DropdownMenuShortcut: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuLabel: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuSub: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuSubContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuSubTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />
}))

// Counts SortableTab's own renders: it is rendered unconditionally inside the tab body, so one
// stub render == one SortableTab render, which the Harness counter above cannot see.
vi.mock('./TerminalTabLeadingIcon', () => ({
  TerminalTabLeadingIcon: () => {
    tabRenderCount += 1
    return <span />
  }
}))

vi.mock('./shell-icons', () => ({ ShellIcon: () => <span /> }))
vi.mock('@/lib/agent-catalog', () => ({ AgentIcon: () => <span /> }))
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

/** Re-renders the tab with a new tab object on every store write, like the tab strip does. */
function ChurningHarness({ titles }: { titles: string[] }): ReactElement {
  const [index, setIndex] = useState(0)
  useEffect(() => {
    if (index < titles.length - 1) {
      setIndex(index + 1)
    }
  }, [index, titles.length])
  return <Harness tab={makeTab({ title: titles[index] })} />
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

  it('settles under title churn while the rename editor is open', () => {
    render(<ChurningHarness titles={['a', 'b', 'c', 'd', 'e', 'f']} />)
    act(() => requestTerminalTabRename('terminal-tab-1'))
    expect(renderCount).toBeLessThan(40)
  })

  // Regression: the shortcut used to arm a store field every tab subscribed to, so one rename
  // re-rendered every mounted tab twice — once to notice the id, once when the tab cleared it.
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

  it('settles under a store write storm', () => {
    render(<Harness tab={makeTab()} />)
    const before = renderCount
    act(() => {
      for (let i = 0; i < 60; i += 1) {
        probeStore.setState({ agentStatusEpoch: i, agentStatusByPaneKey: {} })
      }
    })
    expect(renderCount - before).toBeLessThan(200)
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
