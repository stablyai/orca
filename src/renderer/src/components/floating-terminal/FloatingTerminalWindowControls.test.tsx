import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'
import { toast } from 'sonner'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { resolveStructuredNativeChatSupport } from '../../../../shared/structured-native-chat-launch-route'
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
  launchAgentInNewTab: vi.fn()
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

vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mocks.launchAgentInNewTab
}))

vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => [{ id: 'claude', label: 'Claude' }],
  AgentIcon: function AgentIcon() {
    return null
  }
}))

vi.mock('../../../../shared/tui-agent-selection', () => ({
  isTuiAgentEnabled: () => true
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
const EXISTING_TAB_ID = 'floating-existing-tab'

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset()
  }
  mocks.launchAgentInNewTab.mockReturnValue({
    surface: { kind: 'local-terminal', tabId: NEW_AGENT_TAB_ID },
    startupPlan: { launchCommand: 'claude', launchConfig: {} },
    pasteDraftAfterLaunch: false
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

function clickLaunch(): void {
  const element = FloatingTerminalWindowControls({
    maximized: false,
    onToggleMaximized: vi.fn(),
    onMinimize: vi.fn()
  })
  findOnClickByAriaLabel(element, 'Open Claude in floating workspace')()
}

describe('FloatingTerminalWindowControls default-agent launch', () => {
  it('launches through the shared agent launcher instead of driving tab startup itself', () => {
    clickLaunch()

    expect(mocks.launchAgentInNewTab).toHaveBeenCalledExactlyOnceWith({
      agent: 'claude',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      launchSource: 'shortcut',
      activate: false
    })
    // Why: the whole point of the migration. The shared launcher owns the startup plan and the
    // tab it lands in, so this button must not reach past it into the tab store.
    expect(mocks.createTab).not.toHaveBeenCalled()
    expect(mocks.queueTabStartupCommand).not.toHaveBeenCalled()
    expect(mocks.setTabBarOrder).not.toHaveBeenCalled()
  })

  it('activates the launched terminal tab so the floating panel selects and focuses it', () => {
    clickLaunch()

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
  })

  it('reports a launch the shared launcher could not plan', () => {
    mocks.launchAgentInNewTab.mockReturnValue(null)

    clickLaunch()

    expect(toast.error).toHaveBeenCalledWith('Could not build launch command for Claude.')
    expect(mocks.activateTab).not.toHaveBeenCalled()
  })

  // Why: a floating window has nowhere to keep a structured session, so the launch must resolve a
  // terminal. Pinned against the shared resolver the launcher routes on, not a restatement here.
  it('keeps the floating workspace off the structured route', () => {
    // `claude` is a structured-session provider on a local host, so `floating-workspace` is the
    // only blocker that can produce this result — any other answer means the kind stopped deciding.
    expect(
      resolveStructuredNativeChatSupport({
        agent: 'claude',
        executionHostId: 'local',
        hostCapabilities: null,
        workspaceKind: 'floating'
      })
    ).toEqual({ supported: false, blocker: 'floating-workspace' })
  })
})
