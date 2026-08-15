/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TabGroupPanel from './TabGroupPanel'

const toggleActiveTerminalPaneZoomMock = vi.fn()
let modelOverrides: {
  activeTerminalPaneIsZoomed?: boolean
  canZoomActiveTerminalPane?: boolean
} = {}

vi.mock('@dnd-kit/core', () => ({
  useDroppable: () => ({ setNodeRef: vi.fn() })
}))

vi.mock('../tab-bar/TabBar', () => ({
  default: () => <div data-testid="tab-bar" />
}))

vi.mock('../tab-bar/TabBarQuickCommandsButton', () => ({
  TabBarQuickCommandsButton: () => <button type="button">Quick commands</button>
}))

vi.mock('./useTabGroupWorkspaceModel', () => ({
  useTabGroupWorkspaceModel: () => ({
    activeTab: null,
    browserItems: [],
    commands: {
      activateBrowser: vi.fn(),
      activateEditor: vi.fn(),
      activateTerminal: vi.fn(),
      closeAllEditorTabsInGroup: vi.fn(),
      closeGroup: vi.fn(),
      closeItem: vi.fn(),
      closeOthers: vi.fn(),
      closeToRight: vi.fn(),
      createSplitGroup: vi.fn(),
      duplicateBrowserTab: vi.fn(),
      makePreviewFilePermanent: vi.fn(),
      newBrowserTab: vi.fn(),
      newFileTab: vi.fn(),
      newTerminalTab: vi.fn(),
      newTerminalWithShell: vi.fn(),
      openEntry: vi.fn(),
      pinFile: vi.fn(),
      setTabColor: vi.fn(),
      setTabCustomTitle: vi.fn(),
      toggleActiveTerminalPaneZoom: toggleActiveTerminalPaneZoomMock,
      toggleTerminalPaneExpand: vi.fn()
    },
    editorItems: [],
    expandedPaneByTabId: {},
    activeTerminalPaneIsZoomed: modelOverrides.activeTerminalPaneIsZoomed ?? false,
    canZoomActiveTerminalPane: modelOverrides.canZoomActiveTerminalPane ?? false,
    group: { id: 'group-1', worktreeId: 'wt-1', activeTabId: null, tabOrder: [] },
    groupTabs: [],
    tabBarOrder: [],
    terminalTabs: []
  })
}))

vi.mock('../../store', () => ({
  useAppStore: (
    selector: (state: { rightSidebarOpen: boolean; sidebarOpen: boolean }) => unknown
  ) => selector({ rightSidebarOpen: true, sidebarOpen: true })
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutKeyDetails: () => ({ keys: ['Ctrl', 'Alt', 'Enter'], doubleTap: false })
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => children,
  TooltipContent: ({ children }: { children?: ReactNode }) => <span>{children}</span>
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const mounted: { container: HTMLDivElement; root: Root }[] = []

function renderPanel({
  hasSplitGroups = true,
  isZoomed,
  onTogglePaneZoom
}: {
  hasSplitGroups?: boolean
  isZoomed: boolean
  onTogglePaneZoom: () => void
}): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <TabGroupPanel
        groupId="group-1"
        worktreeId="wt-1"
        isFocused
        hasSplitGroups={hasSplitGroups}
        isZoomed={isZoomed}
        touchesRightEdge
        touchesLeftEdge
        reserveClosedExplorerToggleSpace={false}
        reserveCollapsedSidebarHeaderSpace={false}
        onTogglePaneZoom={onTogglePaneZoom}
      />
    )
  })
  mounted.push({ container, root })
  return container
}

afterEach(() => {
  modelOverrides = {}
  toggleActiveTerminalPaneZoomMock.mockClear()
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
})

describe('TabGroupPanel pane zoom affordance', () => {
  it('shows a zoom button for focused split panes', () => {
    const onTogglePaneZoom = vi.fn()
    const container = renderPanel({ isZoomed: false, onTogglePaneZoom })

    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Zoom pane"]')

    expect(button).not.toBeNull()
    expect(button?.getAttribute('aria-pressed')).toBe('false')

    act(() => button?.click())

    expect(onTogglePaneZoom).toHaveBeenCalledTimes(1)
  })

  it('switches the affordance to restore while zoomed', () => {
    const container = renderPanel({ isZoomed: true, onTogglePaneZoom: vi.fn() })

    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Restore pane"]')

    expect(button).not.toBeNull()
    expect(button?.getAttribute('aria-pressed')).toBe('true')
    expect(container.textContent).toContain('Ctrl')
    expect(container.textContent).toContain('Enter')
  })

  it('shows the zoom button for a focused terminal split in a single tab group', () => {
    modelOverrides = { canZoomActiveTerminalPane: true }
    const onTogglePaneZoom = vi.fn()
    const container = renderPanel({ hasSplitGroups: false, isZoomed: false, onTogglePaneZoom })

    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Zoom pane"]')

    expect(button).not.toBeNull()

    act(() => button?.click())

    expect(toggleActiveTerminalPaneZoomMock).toHaveBeenCalledTimes(1)
    expect(onTogglePaneZoom).not.toHaveBeenCalled()
  })

  it('shows restore state for an already zoomed terminal split', () => {
    modelOverrides = { activeTerminalPaneIsZoomed: true, canZoomActiveTerminalPane: true }
    const container = renderPanel({
      hasSplitGroups: false,
      isZoomed: false,
      onTogglePaneZoom: vi.fn()
    })

    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Restore pane"]')

    expect(button).not.toBeNull()
    expect(button?.getAttribute('aria-pressed')).toBe('true')
  })
})
