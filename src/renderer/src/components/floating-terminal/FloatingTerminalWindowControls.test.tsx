import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { FloatingTerminalWindowControls } from './FloatingTerminalWindowControls'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

const storeBox = vi.hoisted(() => ({
  state: null as unknown
}))

const mocks = vi.hoisted(() => ({
  activateTab: vi.fn(),
  createTab: vi.fn(),
  setActiveTabForWorktree: vi.fn(),
  setTabBarOrder: vi.fn(),
  queueTabStartupCommand: vi.fn(),
  focusTerminalTabSurface: vi.fn(),
  buildAgentStartupPlan: vi.fn()
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof ReactModule>('react')
  return {
    ...actual,
    useCallback: <T,>(callback: T) => callback,
    useMemo: <T,>(factory: () => T) => factory()
  }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(storeBox.state), {
    getState: () => storeBox.state
  })
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))

vi.mock('@/lib/tui-agent-startup', () => ({
  buildAgentStartupPlan: mocks.buildAgentStartupPlan
}))

vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => [{ id: 'claude', label: 'Claude' }],
  AgentIcon: function AgentIcon() {
    return null
  }
}))

vi.mock('@/lib/new-workspace', () => ({
  CLIENT_PLATFORM: 'darwin'
}))

vi.mock('@/lib/telemetry', () => ({
  tuiAgentToAgentKind: () => 'claude'
}))

vi.mock('../../../../shared/tui-agent-selection', () => ({
  isTuiAgentEnabled: () => true
}))

vi.mock('../../../../shared/tui-agent-launch-defaults', () => ({
  resolveTuiAgentLaunchArgs: () => [],
  resolveTuiAgentLaunchEnv: () => ({})
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, vars?: Record<string, string>) =>
    vars ? fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => vars[name] ?? '') : fallback
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useOptionalShortcutLabel: () => null
}))

vi.mock('@/components/ui/button', () => ({
  Button: function Button(props: { children?: unknown }) {
    return props.children ?? null
  }
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: function Tooltip(props: { children?: unknown }) {
    return props.children
  },
  TooltipContent: function TooltipContent(props: { children?: unknown }) {
    return props.children
  },
  TooltipTrigger: function TooltipTrigger(props: { children?: unknown }) {
    return props.children
  }
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: function DropdownMenu(props: { children?: unknown }) {
    return props.children
  },
  DropdownMenuTrigger: function DropdownMenuTrigger(props: { children?: unknown }) {
    return props.children
  },
  DropdownMenuContent: function DropdownMenuContent(props: { children?: unknown }) {
    return props.children
  },
  DropdownMenuItem: function DropdownMenuItem(props: { children?: unknown; onClick?: unknown }) {
    return {
      type: 'DropdownMenuItem',
      props
    }
  },
  DropdownMenuLabel: function DropdownMenuLabel(props: { children?: unknown }) {
    return props.children
  },
  DropdownMenuSeparator: function DropdownMenuSeparator() {
    return null
  }
}))

vi.mock('lucide-react', () => ({
  Check: function Check() {
    return null
  },
  Sparkles: function Sparkles() {
    return null
  },
  ExternalLink: function ExternalLink() {
    return null
  },
  Monitor: function Monitor() {
    return null
  },
  Maximize2: function Maximize2() {
    return null
  },
  Minimize2: function Minimize2() {
    return null
  },
  Minus: function Minus() {
    return null
  }
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  if (!element.props) {
    return
  }
  cb(element)
  if (
    typeof element.type === 'function' &&
    element.type.name !== 'DropdownMenuItem' &&
    element.type.name !== 'Button' &&
    element.type.name !== 'Tooltip' &&
    element.type.name !== 'TooltipContent' &&
    element.type.name !== 'TooltipTrigger'
  ) {
    try {
      const rendered = (element.type as (props: Record<string, unknown>) => unknown)(element.props)
      visit(rendered, cb)
    } catch {
      // ignore
    }
  }
  visit(element.props.children, cb)
}

function findOnClickByAriaLabel(node: unknown, ariaLabel: string): () => void {
  let found: (() => void) | null = null
  visit(node, (entry) => {
    if (entry.props['aria-label'] === ariaLabel && typeof entry.props.onClick === 'function') {
      found = entry.props.onClick as () => void
    }
  })
  if (!found) {
    throw new Error(`onClick for aria-label "${ariaLabel}" not found`)
  }
  return found
}

const NEW_AGENT_TAB_ID = 'floating-agent-tab'
const EXISTING_TAB_ID = 'floating-existing-tab'

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset()
  }
  mocks.createTab.mockImplementation(() => {
    const tab = { id: NEW_AGENT_TAB_ID }
    const state = storeBox.state as { tabsByWorktree: Record<string, { id: string }[]> }
    const existing = state.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []
    state.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] = [...existing, tab]
    return tab
  })
  mocks.buildAgentStartupPlan.mockReturnValue({
    launchCommand: 'claude',
    launchConfig: {},
    env: undefined,
    startupCommandDelivery: undefined
  })
  storeBox.state = {
    settings: {
      defaultTuiAgent: 'claude',
      disabledTuiAgents: [],
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {}
    },
    createTab: mocks.createTab,
    activateTab: mocks.activateTab,
    setActiveTabForWorktree: mocks.setActiveTabForWorktree,
    setTabBarOrder: mocks.setTabBarOrder,
    queueTabStartupCommand: mocks.queueTabStartupCommand,
    tabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [{ id: EXISTING_TAB_ID }] },
    tabBarOrderByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [EXISTING_TAB_ID] }
  }
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('FloatingTerminalWindowControls default-agent launch', () => {
  it('activates the new agent tab so the floating panel selects and focuses it', () => {
    ;(
      storeBox.state as {
        settings: Record<string, unknown>
      }
    ).settings.nativeChatSessionOptions = {
      claude: { model: 'opus', valuesByModel: { opus: { effort: 'high' } } }
    }
    const element = FloatingTerminalWindowControls({
      maximized: false,
      onToggleMaximized: vi.fn(),
      onMinimize: vi.fn()
    })

    const launch = findOnClickByAriaLabel(element, 'Open Claude in floating workspace')
    launch()

    expect(mocks.buildAgentStartupPlan.mock.calls[0]?.[0]).not.toHaveProperty('sessionOptions')

    expect(mocks.createTab).toHaveBeenCalledWith(
      FLOATING_TERMINAL_WORKTREE_ID,
      undefined,
      undefined,
      { activate: false }
    )
    // Why: TerminalPane consumes any pending startup command on first render, so
    // the launch command must be queued before activation can mount the surface -
    // otherwise the new tab can come up as a bare shell.
    expect(mocks.queueTabStartupCommand).toHaveBeenCalledWith(
      NEW_AGENT_TAB_ID,
      expect.objectContaining({
        command: 'claude',
        launchAgent: 'claude'
      })
    )
    expect(mocks.queueTabStartupCommand.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.activateTab.mock.invocationCallOrder[0]
    )
    // Why: the floating panel renders its visible tab from the unified group's
    // activeTabId, which only activateTab writes. setActiveTabForWorktree updates
    // the complementary legacy per-worktree map. Without activateTab the new agent
    // tab would be appended but never selected/focused.
    expect(mocks.setActiveTabForWorktree).toHaveBeenCalledWith(
      FLOATING_TERMINAL_WORKTREE_ID,
      NEW_AGENT_TAB_ID
    )
    expect(mocks.activateTab).toHaveBeenCalledWith(NEW_AGENT_TAB_ID)
    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith(NEW_AGENT_TAB_ID)
    // Why: createTab appends the new tab to the worktree; the order reconciliation
    // must keep the pre-existing tab and place the new agent tab last.
    expect(mocks.setTabBarOrder).toHaveBeenCalledWith(FLOATING_TERMINAL_WORKTREE_ID, [
      EXISTING_TAB_ID,
      NEW_AGENT_TAB_ID
    ])
  })

  it('renders multi-monitor button and moves to next display when 2 monitors exist', () => {
    const onMoveToNextDisplay = vi.fn()
    const onToggleDetached = vi.fn()
    const displays = [
      {
        id: 1,
        label: 'Display 1',
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1040 },
        isPrimary: true,
        scaleFactor: 1
      },
      {
        id: 2,
        label: 'Display 2',
        bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
        workArea: { x: 1920, y: 0, width: 1920, height: 1040 },
        isPrimary: false,
        scaleFactor: 1
      }
    ]

    const element = FloatingTerminalWindowControls({
      maximized: false,
      onToggleMaximized: vi.fn(),
      onMinimize: vi.fn(),
      isDetached: false,
      onToggleDetached,
      displays,
      onMoveToNextDisplay
    })

    const items: { onClick: () => void }[] = []
    visit(element, (entry) => {
      if (
        typeof entry.type === 'function' &&
        entry.type.name === 'DropdownMenuItem' &&
        typeof entry.props.onClick === 'function'
      ) {
        items.push({ onClick: entry.props.onClick as () => void })
      }
    })
    expect(items.length).toBeGreaterThanOrEqual(2)
    items[0].onClick()
    expect(onMoveToNextDisplay).toHaveBeenCalledOnce()

    const detachButton = findOnClickByAriaLabel(
      element,
      'Detach floating workspace to separate window'
    )
    detachButton()
    expect(onToggleDetached).toHaveBeenCalledOnce()
  })

  it('renders dock button when detached', () => {
    const onToggleDetached = vi.fn()

    const element = FloatingTerminalWindowControls({
      maximized: false,
      onToggleMaximized: vi.fn(),
      onMinimize: vi.fn(),
      isDetached: true,
      onToggleDetached
    })

    const dockButton = findOnClickByAriaLabel(element, 'Dock floating workspace into main window')
    dockButton()
    expect(onToggleDetached).toHaveBeenCalledOnce()
  })

  it('renders displays dropdown menu and triggers target display selection and identify displays', () => {
    const onMoveToDisplay = vi.fn()
    const onIdentifyDisplays = vi.fn()
    const displays = [
      {
        id: 10,
        label: 'Monitor 1 (Primary)',
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1040 },
        isPrimary: true,
        scaleFactor: 1
      },
      {
        id: 20,
        label: 'Monitor 2',
        bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
        workArea: { x: 1920, y: 0, width: 2560, height: 1400 },
        isPrimary: false,
        scaleFactor: 1
      }
    ]

    const element = FloatingTerminalWindowControls({
      maximized: false,
      onToggleMaximized: vi.fn(),
      onMinimize: vi.fn(),
      isDetached: false,
      displays,
      onMoveToDisplay,
      onIdentifyDisplays
    })

    const items: { onClick: () => void; text?: string }[] = []
    visit(element, (entry) => {
      if (
        typeof entry.type === 'function' &&
        entry.type.name === 'DropdownMenuItem' &&
        typeof entry.props.onClick === 'function'
      ) {
        items.push({ onClick: entry.props.onClick as () => void })
      }
    })

    // Expect items: display 1, display 2, identify displays
    expect(items.length).toBeGreaterThanOrEqual(3)

    // Click display 2
    items[1].onClick()
    expect(onMoveToDisplay).toHaveBeenCalledWith(20)

    // Click identify displays
    items[2].onClick()
    expect(onIdentifyDisplays).toHaveBeenCalledOnce()
  })
})
