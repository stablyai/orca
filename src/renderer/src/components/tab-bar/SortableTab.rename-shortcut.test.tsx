import { beforeEach, describe, expect, it, vi } from 'vitest'

const reactHookRuntime = vi.hoisted(() => ({
  states: [] as unknown[],
  index: 0
}))

const storeState = vi.hoisted(() => ({
  agentStatusByPaneKey: {},
  clearTabLaunchAgent: vi.fn(),
  ptyIdsByTabId: {} as Record<string, string[]>,
  renamingTabId: null as string | null,
  repos: [],
  setRenamingTabId: vi.fn((tabId: string | null) => {
    storeState.renamingTabId = tabId
  }),
  terminalLayoutsByTabId: {},
  worktreesByRepo: {},
  unreadTerminalTabs: {} as Record<string, boolean>
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    useCallback<T>(callback: T) {
      return callback
    },
    useEffect(effect: () => void | (() => void)) {
      effect()
    },
    useRef<T>(initial: T) {
      return { current: initial }
    },
    useState<T>(initial: T | (() => T)) {
      const stateIndex = reactHookRuntime.index++
      if (!(stateIndex in reactHookRuntime.states)) {
        reactHookRuntime.states[stateIndex] =
          typeof initial === 'function' ? (initial as () => T)() : initial
      }
      const setState = (next: T | ((previous: T) => T)): void => {
        reactHookRuntime.states[stateIndex] =
          typeof next === 'function'
            ? (next as (previous: T) => T)(reactHookRuntime.states[stateIndex] as T)
            : next
      }
      return [reactHookRuntime.states[stateIndex] as T, setState] as const
    }
  }
})

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({
    attributes: {},
    listeners: { onPointerDown: vi.fn() },
    setNodeRef: vi.fn()
  })
}))

vi.mock('lucide-react', () => ({
  Columns2: function Columns2(props: Record<string, unknown>) {
    return { type: 'Columns2', props }
  },
  Minimize2: function Minimize2(props: Record<string, unknown>) {
    return { type: 'Minimize2', props }
  },
  Pin: function Pin(props: Record<string, unknown>) {
    return { type: 'Pin', props }
  },
  PinOff: function PinOff(props: Record<string, unknown>) {
    return { type: 'PinOff', props }
  },
  Rows2: function Rows2(props: Record<string, unknown>) {
    return { type: 'Rows2', props }
  },
  X: function X(props: Record<string, unknown>) {
    return { type: 'X', props }
  }
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: function DropdownMenu(props: { children?: unknown }) {
    return { type: 'DropdownMenu', props }
  },
  DropdownMenuContent: function DropdownMenuContent(props: { children?: unknown }) {
    return { type: 'DropdownMenuContent', props }
  },
  DropdownMenuItem: function DropdownMenuItem(props: { children?: unknown }) {
    return { type: 'DropdownMenuItem', props }
  },
  DropdownMenuSeparator: function DropdownMenuSeparator() {
    return { type: 'DropdownMenuSeparator', props: {} }
  },
  DropdownMenuTrigger: function DropdownMenuTrigger(props: { children?: unknown }) {
    return props.children
  }
}))

vi.mock('@/components/ui/input', () => ({
  Input: function Input(props: Record<string, unknown>) {
    return { type: 'input', props }
  }
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: function Tooltip(props: { children?: unknown }) {
    return { type: 'Tooltip', props }
  },
  TooltipContent: function TooltipContent(props: { children?: unknown }) {
    return { type: 'TooltipContent', props }
  },
  TooltipTrigger: function TooltipTrigger(props: { children?: unknown }) {
    return props.children
  }
}))

vi.mock('./shell-icons', () => ({
  ShellIcon: function ShellIcon(props: Record<string, unknown>) {
    return { type: 'ShellIcon', props }
  }
}))

vi.mock('../sidebar/WorktreeCardHelpers', () => ({
  FilledBellIcon: function FilledBellIcon(props: Record<string, unknown>) {
    return { type: 'FilledBellIcon', props }
  }
}))

vi.mock('./drop-indicator', () => ({
  ACTIVE_TAB_INDICATOR_CLASSES: 'active-tab-indicator',
  getDropIndicatorClasses: () => '',
  getTabRootStateClasses: () => ''
}))

vi.mock('./middle-button-default-guard', () => ({
  preventMiddleButtonDefault: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function makeTerminalTab() {
  return {
    id: 'terminal-tab-1',
    title: 'Runtime terminal title',
    customTitle: null,
    type: 'terminal',
    worktreeId: 'wt-1',
    createdAt: 0
  }
}

async function renderSortableTab(): Promise<unknown> {
  reactHookRuntime.index = 0
  const module = await import('./SortableTab')
  return module.default({
    tab: makeTerminalTab() as never,
    tabCount: 1,
    hasTabsToRight: false,
    isActive: true,
    isPinned: false,
    isExpanded: false,
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onCloseOthers: vi.fn(),
    onCloseToRight: vi.fn(),
    onSetCustomTitle: vi.fn(),
    onSetTabColor: vi.fn(),
    onTogglePin: vi.fn(),
    onToggleExpand: vi.fn(),
    onSplitGroup: vi.fn(),
    dragData: {
      kind: 'tab',
      worktreeId: 'wt-1',
      groupId: 'group-1',
      unifiedTabId: 'terminal-tab-1',
      visibleTabId: 'terminal-tab-1',
      tabType: 'terminal',
      label: 'Runtime terminal title'
    }
  })
}

function expandNode(node: unknown): unknown {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return node
  }
  if (Array.isArray(node)) {
    return node.map(expandNode)
  }
  const el = node as ReactElementLike
  if (typeof el.type === 'function') {
    return expandNode(el.type(el.props))
  }
  return {
    ...el,
    props: {
      ...el.props,
      children: expandNode(el.props?.children)
    }
  }
}

function findElementsByType(node: unknown, typeName: string): ReactElementLike[] {
  const results: ReactElementLike[] = []
  const visit = (current: unknown): void => {
    if (current == null || typeof current === 'string' || typeof current === 'number') {
      return
    }
    if (Array.isArray(current)) {
      for (const child of current) {
        visit(child)
      }
      return
    }
    const el = current as ReactElementLike
    if (el.type === typeName) {
      results.push(el)
    }
    visit(el.props?.children)
  }
  visit(node)
  return results
}

describe('SortableTab rename shortcut signal', () => {
  beforeEach(() => {
    reactHookRuntime.states = []
    reactHookRuntime.index = 0
    storeState.renamingTabId = 'terminal-tab-1'
    storeState.unreadTerminalTabs = {}
    storeState.clearTabLaunchAgent.mockClear()
    storeState.setRenamingTabId.mockClear()
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  it('opens the inline rename input and consumes the matching store signal', async () => {
    await renderSortableTab()
    const rerender = expandNode(await renderSortableTab())
    const inputs = findElementsByType(rerender, 'input')

    expect(storeState.setRenamingTabId).toHaveBeenCalledWith(null)
    expect(storeState.renamingTabId).toBeNull()
    expect(inputs).toHaveLength(1)
    expect(inputs[0].props.value).toBe('Runtime terminal title')
    expect(inputs[0].props['data-tab-rename-input']).toBe('true')
  })
})
