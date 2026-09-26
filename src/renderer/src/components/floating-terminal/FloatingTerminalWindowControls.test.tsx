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
  createTab: vi.fn(),
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
      launchSource: 'shortcut'
    })
    // Why: the whole point of the migration. The shared launcher owns the startup plan and the
    // tab it lands in, so this button must not reach past it into the tab store.
    expect(mocks.createTab).not.toHaveBeenCalled()
    expect(mocks.queueTabStartupCommand).not.toHaveBeenCalled()
    expect(mocks.setTabBarOrder).not.toHaveBeenCalled()
  })

  it('focuses the launched terminal tab', () => {
    clickLaunch()

    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith(NEW_AGENT_TAB_ID)
  })

  it('reports a launch the shared launcher could not plan', () => {
    mocks.launchAgentInNewTab.mockReturnValue(null)

    clickLaunch()

    expect(toast.error).toHaveBeenCalledWith('Could not build launch command for Claude.')
    expect(mocks.focusTerminalTabSurface).not.toHaveBeenCalled()
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
