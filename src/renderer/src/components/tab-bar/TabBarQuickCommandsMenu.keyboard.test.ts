import { beforeEach, describe, expect, it, vi } from 'vitest'

// Capture window keydown listeners so tests can fire them directly.
const windowListeners = vi.hoisted(() => new Map<string, (e: KeyboardEvent) => void>())

const keybindingsMock = vi.hoisted(() => ({
  matchAction: vi.fn().mockReturnValue(false)
}))

const appStoreMock = vi.hoisted(() => ({
  state: {
    activeView: 'terminal' as 'terminal' | 'settings',
    keybindings: {} as Record<string, string[]>,
    settings: {
      terminalShortcutPolicy: 'orca-first' as 'orca-first' | 'terminal-first'
    }
  }
}))

// Minimal React hook runtime: track useState values and useEffect callbacks.
const reactRuntime = vi.hoisted(() => ({
  states: [] as unknown[],
  index: 0,
  effects: [] as (() => void | (() => void))[]
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    useState<T>(initial: T | (() => T)) {
      const i = reactRuntime.index++
      if (!(i in reactRuntime.states)) {
        reactRuntime.states[i] = typeof initial === 'function' ? (initial as () => T)() : initial
      }
      const setState = (next: T | ((prev: T) => T)): void => {
        reactRuntime.states[i] =
          typeof next === 'function' ? (next as (p: T) => T)(reactRuntime.states[i] as T) : next
      }
      return [reactRuntime.states[i] as T, setState] as const
    },
    useEffect(effect: () => void | (() => void)) {
      reactRuntime.effects.push(effect)
    },
    useCallback<T>(fn: T): T {
      return fn
    },
    useMemo<T>(fn: () => T): T {
      return fn()
    },
    useRef<T>(init: T) {
      return { current: init }
    }
  }
})

vi.mock('../../../../shared/keybindings', () => ({
  keybindingMatchesAction: keybindingsMock.matchAction
}))

vi.mock('@/lib/shortcut-platform', () => ({
  getShortcutPlatform: () => 'darwin' as const
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (s: typeof appStoreMock.state) => unknown) => selector(appStoreMock.state)
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutKeyComboDetails: () => []
}))

vi.mock('@/lib/terminal-quick-command-search', () => ({
  searchTerminalQuickCommands: (_cmds: unknown[], _q: string) => [],
  getTerminalQuickCommandPickerValue: () => null
}))

vi.mock('../../../../shared/terminal-quick-commands', () => ({
  isTerminalAgentQuickCommand: () => false,
  getTerminalQuickCommandBody: () => ''
}))

vi.mock('@/lib/agent-catalog', () => ({
  getAgentLabel: () => '',
  AgentIcon: () => null
}))

vi.mock('./TabBarQuickCommandItem', () => ({
  TabBarQuickCommandItem: () => null
}))

vi.mock('@/lib/utils', () => ({
  cn: (...args: string[]) => args.filter(Boolean).join(' ')
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('lucide-react', () => ({
  ChevronDown: () => null,
  Play: () => null,
  Plus: () => null
}))

vi.mock('@/components/ui/command', () => ({
  Command: () => null,
  CommandEmpty: () => null,
  CommandInput: () => null,
  CommandList: () => null,
  CommandSeparator: () => null
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: () => null,
  DropdownMenuContent: () => null,
  DropdownMenuTrigger: () => null
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: () => null,
  TooltipContent: () => null,
  TooltipTrigger: () => null
}))

function makeProps() {
  return {
    repoCommands: [] as never[],
    globalCommands: [] as never[],
    mostRecent: null,
    onAddCommand: vi.fn(),
    onDeleteCommand: vi.fn(),
    onEditCommand: vi.fn(),
    onRunCommand: vi.fn()
  }
}

function makeKeyEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    key: 'q',
    code: 'KeyQ',
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: true,
    ...overrides
  } as unknown as KeyboardEvent
}

beforeEach(() => {
  reactRuntime.states = []
  reactRuntime.index = 0
  reactRuntime.effects = []
  windowListeners.clear()
  keybindingsMock.matchAction.mockClear()
  keybindingsMock.matchAction.mockReturnValue(false)
  appStoreMock.state.activeView = 'terminal'
  appStoreMock.state.keybindings = {}
  appStoreMock.state.settings.terminalShortcutPolicy = 'orca-first'
  vi.stubGlobal('window', {
    addEventListener: vi.fn((type: string, handler: (e: KeyboardEvent) => void) => {
      windowListeners.set(type, handler)
    }),
    removeEventListener: vi.fn()
  })
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

describe('TabBarQuickCommandsMenu keyboard shortcut', () => {
  it('registers a capturing keydown listener on mount', async () => {
    reactRuntime.index = 0
    const { TabBarQuickCommandsMenu } = await import('./TabBarQuickCommandsMenu')
    TabBarQuickCommandsMenu(makeProps())

    // Effect index 0 is the keyboard toggle effect.
    reactRuntime.effects[0]()

    expect(window.addEventListener).toHaveBeenCalledWith('keydown', expect.any(Function), {
      capture: true
    })
    expect(window.addEventListener).toHaveBeenCalledWith('keyup', expect.any(Function), {
      capture: true
    })
  })

  it('does not register keyboard listeners while the terminal workbench is hidden', async () => {
    appStoreMock.state.activeView = 'settings'
    reactRuntime.index = 0
    const { TabBarQuickCommandsMenu } = await import('./TabBarQuickCommandsMenu')
    TabBarQuickCommandsMenu(makeProps())

    reactRuntime.effects[0]()

    expect(window.addEventListener).not.toHaveBeenCalledWith('keydown', expect.any(Function), {
      capture: true
    })
    expect(window.addEventListener).not.toHaveBeenCalledWith('keyup', expect.any(Function), {
      capture: true
    })
  })

  it('toggles menuOpen to true when a matching key is pressed', async () => {
    reactRuntime.index = 0
    const { TabBarQuickCommandsMenu } = await import('./TabBarQuickCommandsMenu')
    TabBarQuickCommandsMenu(makeProps())

    reactRuntime.effects[0]()

    keybindingsMock.matchAction.mockReturnValue(true)
    const handler = windowListeners.get('keydown')
    expect(handler).toBeDefined()
    handler!(makeKeyEvent())

    // menuOpen is useState index 0, initial false → toggled to true.
    expect(reactRuntime.states[0]).toBe(true)
  })

  it('toggles menuOpen closed when pressed again', async () => {
    reactRuntime.index = 0
    const { TabBarQuickCommandsMenu } = await import('./TabBarQuickCommandsMenu')
    TabBarQuickCommandsMenu(makeProps())
    reactRuntime.effects[0]()

    keybindingsMock.matchAction.mockReturnValue(true)
    windowListeners.get('keydown')!(makeKeyEvent())
    expect(reactRuntime.states[0]).toBe(true)

    // Simulate React re-running the effect after menuOpen changed to true,
    // so the handler closes over the updated value.
    reactRuntime.index = 0
    reactRuntime.effects = []
    TabBarQuickCommandsMenu(makeProps())
    reactRuntime.effects[0]()

    windowListeners.get('keydown')!(makeKeyEvent())
    expect(reactRuntime.states[0]).toBe(false)
  })

  it('does not toggle when the event is a repeat (key held down)', async () => {
    reactRuntime.index = 0
    const { TabBarQuickCommandsMenu } = await import('./TabBarQuickCommandsMenu')
    TabBarQuickCommandsMenu(makeProps())

    reactRuntime.effects[0]()

    keybindingsMock.matchAction.mockReturnValue(true)
    const handler = windowListeners.get('keydown')!
    handler(makeKeyEvent({ repeat: true }))

    expect(reactRuntime.states[0]).toBe(false)
  })

  it('does not toggle when the key does not match the action', async () => {
    reactRuntime.index = 0
    const { TabBarQuickCommandsMenu } = await import('./TabBarQuickCommandsMenu')
    TabBarQuickCommandsMenu(makeProps())

    reactRuntime.effects[0]()

    keybindingsMock.matchAction.mockReturnValue(false)
    const handler = windowListeners.get('keydown')!
    handler(makeKeyEvent())

    expect(reactRuntime.states[0]).toBe(false)
  })

  it('prevents default and stops propagation for matching keys', async () => {
    reactRuntime.index = 0
    const { TabBarQuickCommandsMenu } = await import('./TabBarQuickCommandsMenu')
    TabBarQuickCommandsMenu(makeProps())

    reactRuntime.effects[0]()

    keybindingsMock.matchAction.mockReturnValue(true)
    const event = makeKeyEvent()
    windowListeners.get('keydown')!(event)

    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.stopImmediatePropagation).toHaveBeenCalled()
  })

  it('passes terminal context and terminal-first policy to shortcut matching', async () => {
    appStoreMock.state.settings.terminalShortcutPolicy = 'terminal-first'
    reactRuntime.index = 0
    const { TabBarQuickCommandsMenu } = await import('./TabBarQuickCommandsMenu')
    TabBarQuickCommandsMenu(makeProps())

    reactRuntime.effects[0]()

    const terminalTarget = {
      classList: { contains: (className: string) => className === 'xterm-helper-textarea' },
      closest: () => null
    } as unknown as EventTarget
    const handler = windowListeners.get('keydown')!
    handler(makeKeyEvent({ target: terminalTarget }))

    expect(keybindingsMock.matchAction).toHaveBeenCalledWith(
      'tab.openQuickCommandsMenu',
      expect.objectContaining({ key: 'q', code: 'KeyQ' }),
      'darwin',
      appStoreMock.state.keybindings,
      { context: 'terminal', terminalShortcutPolicy: 'terminal-first' }
    )
    expect(reactRuntime.states[0]).toBe(false)
  })

  it('ignores shortcut presses while the shortcut recorder is active', async () => {
    reactRuntime.index = 0
    const { TabBarQuickCommandsMenu } = await import('./TabBarQuickCommandsMenu')
    TabBarQuickCommandsMenu(makeProps())

    reactRuntime.effects[0]()

    const recorderTarget = {
      closest: (selector: string) => (selector === '[data-shortcut-recorder-active]' ? {} : null)
    } as unknown as EventTarget
    const handler = windowListeners.get('keydown')!
    handler(makeKeyEvent({ target: recorderTarget }))

    expect(keybindingsMock.matchAction).not.toHaveBeenCalled()
    expect(reactRuntime.states[0]).toBe(false)
  })

  it('toggles from a matching double-tap binding in the renderer path', async () => {
    reactRuntime.index = 0
    const { TabBarQuickCommandsMenu } = await import('./TabBarQuickCommandsMenu')
    TabBarQuickCommandsMenu(makeProps())

    reactRuntime.effects[0]()

    keybindingsMock.matchAction.mockImplementation(
      (_actionId, input: { doubleTapModifier?: string }) => input.doubleTapModifier === 'Shift'
    )
    const keyDown = windowListeners.get('keydown')!
    const keyUp = windowListeners.get('keyup')!
    const firstDown = makeKeyEvent({
      key: 'Shift',
      code: 'ShiftLeft',
      metaKey: false,
      shiftKey: true
    })
    const firstUp = makeKeyEvent({
      key: 'Shift',
      code: 'ShiftLeft',
      metaKey: false,
      shiftKey: true
    })
    const secondDown = makeKeyEvent({
      key: 'Shift',
      code: 'ShiftLeft',
      metaKey: false,
      shiftKey: true
    })

    keyDown(firstDown)
    keyUp(firstUp)
    keyDown(secondDown)

    expect(reactRuntime.states[0]).toBe(true)
    expect(secondDown.preventDefault).toHaveBeenCalled()
    expect(secondDown.stopImmediatePropagation).toHaveBeenCalled()
  })

  it('removes the listener when the effect is cleaned up', async () => {
    reactRuntime.index = 0
    const { TabBarQuickCommandsMenu } = await import('./TabBarQuickCommandsMenu')
    TabBarQuickCommandsMenu(makeProps())

    const cleanup = reactRuntime.effects[0]()
    cleanup?.()

    expect(window.removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function), {
      capture: true
    })
    expect(window.removeEventListener).toHaveBeenCalledWith('keyup', expect.any(Function), {
      capture: true
    })
  })
})
