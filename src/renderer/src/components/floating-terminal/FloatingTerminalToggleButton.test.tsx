import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_TRIGGER_POSITION_STORAGE_KEY } from './floating-terminal-trigger-position'

type EffectCallback = () => void | (() => void)

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

const hookRuntime = vi.hoisted(() => ({
  effects: [] as EffectCallback[],
  layoutEffects: [] as EffectCallback[],
  index: 0,
  values: [] as unknown[]
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    useCallback: <T,>(callback: T) => callback,
    useEffect: (effect: EffectCallback) => {
      hookRuntime.effects.push(effect)
    },
    useLayoutEffect: (effect: EffectCallback) => {
      hookRuntime.layoutEffects.push(effect)
    },
    useRef: <T,>(initialValue: T) => {
      const index = hookRuntime.index
      hookRuntime.index += 1
      if (hookRuntime.values[index] === undefined) {
        hookRuntime.values[index] = { current: initialValue }
      }
      return hookRuntime.values[index] as { current: T }
    },
    useState: <T,>(initialValue: T | (() => T)) => {
      const index = hookRuntime.index
      hookRuntime.index += 1
      if (hookRuntime.values[index] === undefined) {
        hookRuntime.values[index] =
          typeof initialValue === 'function' ? (initialValue as () => T)() : initialValue
      }
      const setValue = (nextValue: T | ((current: T) => T)): void => {
        hookRuntime.values[index] =
          typeof nextValue === 'function'
            ? (nextValue as (current: T) => T)(hookRuntime.values[index] as T)
            : nextValue
      }
      return [hookRuntime.values[index] as T, setValue] as const
    }
  }
})

vi.mock('lucide-react', () => ({
  PanelsTopLeft: function PanelsTopLeft() {
    return null
  }
}))

vi.mock('@/components/ui/button', () => ({
  Button: function Button() {
    return null
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

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: () => 'Cmd+`'
}))

vi.mock('./FloatingTerminalIconContextMenu', () => ({
  FloatingTerminalIconContextMenu: function FloatingTerminalIconContextMenu(props: {
    children?: unknown
  }) {
    return props.children
  }
}))

const storeState = vi.hoisted(() => ({ hasFloatingUnread: false }))

vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: typeof storeState) => T): T => selector(storeState)
}))

// The real selector is covered in store/selectors.test.ts; here it just reads
// the mocked flag so the dot's show/hide logic can be exercised in isolation.
vi.mock('@/store/selectors', () => ({
  selectFloatingWorkspaceHasUnread: (state: typeof storeState): boolean => state.hasFloatingUnread
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

function findByProp(node: unknown, propName: string): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.props[propName]) {
      found = entry
    }
  })
  if (!found) {
    throw new Error(`${propName} not found`)
  }
  return found
}

function hasProp(node: unknown, propName: string): boolean {
  let found = false
  visit(node, (entry) => {
    if (entry.props[propName]) {
      found = true
    }
  })
  return found
}

function runEffects(): void {
  const layoutEffects = hookRuntime.layoutEffects.splice(0)
  for (const effect of layoutEffects) {
    effect()
  }
  const effects = hookRuntime.effects.splice(0)
  for (const effect of effects) {
    effect()
  }
}

async function renderToggle(open = false, onToggle = vi.fn()): Promise<unknown> {
  hookRuntime.index = 0
  const { FloatingTerminalToggleButton } = await import('./FloatingTerminalToggleButton')
  return FloatingTerminalToggleButton({ open, onToggle })
}

function getToggleStylePosition(element: unknown): { left: number; top: number } {
  const container = findByProp(element, 'currentLocation')
  const style = container.props.style as Record<string, number>
  return { left: style.left, top: style.top }
}

function getToggleButton(element: unknown): ReactElementLike {
  return findByProp(element, 'data-floating-terminal-toggle')
}

function getMockedLocalStorage(): {
  getItem: ReturnType<typeof vi.fn>
  setItem: ReturnType<typeof vi.fn>
} {
  return window.localStorage as unknown as {
    getItem: ReturnType<typeof vi.fn>
    setItem: ReturnType<typeof vi.fn>
  }
}

function setViewport(width: number, height: number): void {
  const viewport = window as unknown as { innerHeight: number; innerWidth: number }
  viewport.innerWidth = width
  viewport.innerHeight = height
}

describe('FloatingTerminalToggleButton positioning', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hookRuntime.effects = []
    hookRuntime.layoutEffects = []
    hookRuntime.index = 0
    hookRuntime.values = []
    const localStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn()
    }
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      innerHeight: 800,
      innerWidth: 1200,
      localStorage,
      removeEventListener: vi.fn()
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('restores an anchored right-bottom placement after a skinny viewport clamp', async () => {
    getMockedLocalStorage().getItem.mockImplementation((key: string) =>
      key === FLOATING_TERMINAL_TRIGGER_POSITION_STORAGE_KEY
        ? '{"anchorX":"right","anchorY":"bottom","offsetX":48,"offsetY":80}'
        : null
    )
    setViewport(260, 220)

    let element = await renderToggle()
    expect(getToggleStylePosition(element)).toEqual({ left: 176, top: 104 })

    setViewport(1200, 800)
    runEffects()
    element = await renderToggle()

    expect(getToggleStylePosition(element)).toEqual({ left: 1116, top: 684 })
    expect(getMockedLocalStorage().setItem).not.toHaveBeenCalled()
  })

  it('previews drag movement without writing storage until pointer end', async () => {
    let element = await renderToggle()
    const button = getToggleButton(element)

    ;(button.props.onPointerDown as (event: unknown) => void)({
      button: 0,
      clientX: 0,
      clientY: 0,
      currentTarget: { setPointerCapture: vi.fn() },
      pointerId: 1
    })
    ;(button.props.onPointerMove as (event: unknown) => void)({
      clientX: -100,
      clientY: -100,
      pointerId: 1
    })

    element = await renderToggle()
    expect(getToggleStylePosition(element)).toEqual({ left: 1040, top: 592 })
    expect(getMockedLocalStorage().setItem).not.toHaveBeenCalled()

    const movedButton = getToggleButton(element)
    ;(movedButton.props.onPointerUp as (event: unknown) => void)({ pointerId: 1 })

    expect(getMockedLocalStorage().setItem).toHaveBeenCalledWith(
      FLOATING_TERMINAL_TRIGGER_POSITION_STORAGE_KEY,
      '{"anchorX":"right","anchorY":"bottom","offsetX":124,"offsetY":172}'
    )
  })
})

describe('FloatingTerminalToggleButton attention dot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hookRuntime.effects = []
    hookRuntime.layoutEffects = []
    hookRuntime.index = 0
    hookRuntime.values = []
    storeState.hasFloatingUnread = false
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      innerHeight: 800,
      innerWidth: 1200,
      localStorage: { getItem: vi.fn(() => null), setItem: vi.fn() },
      removeEventListener: vi.fn()
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the attention dot when closed with pending floating activity', async () => {
    storeState.hasFloatingUnread = true
    const element = await renderToggle(false)
    expect(hasProp(element, 'data-floating-terminal-attention')).toBe(true)
  })

  it('hides the dot when the panel is open even with pending activity', async () => {
    storeState.hasFloatingUnread = true
    const element = await renderToggle(true)
    expect(hasProp(element, 'data-floating-terminal-attention')).toBe(false)
  })

  it('hides the dot when there is no pending activity', async () => {
    storeState.hasFloatingUnread = false
    const element = await renderToggle(false)
    expect(hasProp(element, 'data-floating-terminal-attention')).toBe(false)
  })
})
