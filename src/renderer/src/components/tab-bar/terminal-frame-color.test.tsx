/**
 * @vitest-environment happy-dom
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SortableTab from './SortableTab'
import { PRESET_TAB_COLORS } from './tab-colors'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

const storeMock = vi.hoisted(() => ({
  state: {
    keybindings: {},
    tabsByWorktree: {
      'wt-1': [
        { id: 'tab-1', worktreeId: 'wt-1', title: 'term-1', color: '#a855f7' },
        { id: 'tab-2', worktreeId: 'wt-1', title: 'term-2', color: null }
      ]
    },
    unreadTerminalTabs: {},
    unreadAgentCompletionPanes: {},
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    runtimePaneTitlesByTabId: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {}
  } as Record<string, unknown>
}))

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(storeMock.state),
    {
      getState: () => storeMock.state
    }
  )
}))

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn()
  })
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  formatShortcutLabel: () => '⌘W',
  useOptionalShortcutLabel: () => '⌘W'
}))

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => children,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => children
}))

vi.mock('@/lib/use-tab-agent', () => ({
  useTabAgent: () => null
}))

const mounted: { container: HTMLDivElement; root: Root }[] = []

function renderTab(tabOverrides: Partial<TerminalTab> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const defaultTab: TerminalTab = {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'test-tab',
    customTitle: null,
    color: '#a855f7',
    sortOrder: 0,
    createdAt: 0
  }

  const tab: TerminalTab = { ...defaultTab, ...tabOverrides }

  act(() => {
    root.render(
      <SortableTab
        tab={tab}
        unifiedTabId={tab.id}
        groupId="group-1"
        tabCount={2}
        hasTabsToRight={false}
        hasTabsToLeft={false}
        isActive={true}
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
        dragData={{
          kind: 'tab',
          worktreeId: 'wt-1',
          groupId: 'group-1',
          unifiedTabId: tab.id,
          visibleTabId: tab.id,
          tabType: 'terminal',
          label: tab.title ?? '',
          color: tab.color
        }}
      />
    )
  })

  mounted.push({ container, root })
  return { container, root }
}

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
})

describe('PRESET_TAB_COLORS', () => {
  it('contains none (null) and multiple distinct color presets', () => {
    expect(PRESET_TAB_COLORS.length).toBeGreaterThanOrEqual(10)
    expect(PRESET_TAB_COLORS[0].value).toBeNull()
    const colorValues = PRESET_TAB_COLORS.slice(1).map((c) => c.value)
    expect(colorValues).toContain('#3b82f6')
    expect(colorValues).toContain('#a855f7')
    expect(colorValues).toContain('#ef4444')
    expect(colorValues).toContain('#22c55e')
  })
})

describe('SortableTab Frame Color Visual Indicators', () => {
  it('renders top color border bar and wash tint when tab.color is set', () => {
    const { container } = renderTab({ color: '#a855f7' })

    const tabRoot = container.querySelector('[data-testid="sortable-tab"]') as HTMLElement
    expect(tabRoot).toBeTruthy()
    expect(tabRoot.getAttribute('data-tab-color')).toBe('#a855f7')

    // Find the top border bar
    const topBar = container.querySelector('span[style*="rgb(168, 85, 247)"], span[style*="#a855f7"]')
    expect(topBar).toBeTruthy()

    // Find the terminal index badge with matching color
    const indexBadge = container.querySelector('[data-testid="tab-terminal-index"]') as HTMLElement
    expect(indexBadge).toBeTruthy()
    expect(indexBadge.style.color).toBe('#a855f7')
  })

  it('omits top border bar and wash tint when tab.color is null', () => {
    const { container } = renderTab({ color: null })

    const tabRoot = container.querySelector('[data-testid="sortable-tab"]') as HTMLElement
    expect(tabRoot).toBeTruthy()
    expect(tabRoot.getAttribute('data-tab-color')).toBeNull()

    const indexBadge = container.querySelector('[data-testid="tab-terminal-index"]') as HTMLElement
    expect(indexBadge).toBeTruthy()
    expect(indexBadge.style.color).toBe('')
  })
})
