import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
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

vi.mock('lucide-react', () => ({
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

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset()
  }
  mocks.createTab.mockReturnValue({ id: NEW_AGENT_TAB_ID })
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
    tabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [{ id: NEW_AGENT_TAB_ID }] },
    tabBarOrderByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [] }
  }
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('FloatingTerminalWindowControls default-agent launch', () => {
  it('activates the new agent tab so the floating panel selects and focuses it', () => {
    const element = FloatingTerminalWindowControls({
      maximized: false,
      onToggleMaximized: vi.fn(),
      onMinimize: vi.fn()
    })

    const launch = findOnClickByAriaLabel(element, 'Open Claude in floating workspace')
    launch()

    expect(mocks.createTab).toHaveBeenCalledWith(
      FLOATING_TERMINAL_WORKTREE_ID,
      undefined,
      undefined,
      { activate: false }
    )
    // Why: the floating panel renders its visible tab from the unified group's
    // activeTabId, which only activateTab writes. Without it the new agent tab
    // would be appended but never selected/focused.
    expect(mocks.activateTab).toHaveBeenCalledWith(NEW_AGENT_TAB_ID)
    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith(NEW_AGENT_TAB_ID)
  })
})
