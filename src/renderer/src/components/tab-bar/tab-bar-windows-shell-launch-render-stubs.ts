import type * as ReactModule from 'react'
import { vi } from 'vitest'

// Headless React: hooks are stubbed so TabBar can be invoked as a plain function.
export async function stubHeadlessReact(): Promise<Record<string, unknown>> {
  const actual = await vi.importActual<typeof ReactModule>('react')
  const contextDefaults = new WeakMap<object, unknown>()
  return {
    ...actual,
    memo: <T>(component: T) => component,
    createContext: <T>(defaultValue: T) => {
      const context = actual.createContext(defaultValue)
      contextDefaults.set(context, defaultValue)
      return context
    },
    useContext: (context: ReactModule.Context<unknown>) => contextDefaults.get(context),
    useEffect: () => {},
    useLayoutEffect: () => {},
    useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
    useMemo: <T>(factory: () => T) => factory(),
    useRef: <T>(current: T) => ({ current }),
    useState: <T>(initial: T | (() => T)) => {
      const value = typeof initial === 'function' ? (initial as () => T)() : initial
      return [value, vi.fn()] as const
    },
    // Stub external-store reads because shallow component calls have no React dispatcher.
    useSyncExternalStore: <T>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot()
  }
}

// Pass selectors through because the headless hook runtime cannot run Zustand’s useRef.
export function stubShallowSelector(): Record<string, unknown> {
  return { useShallow: (selector: unknown) => selector }
}

export function stubSortableContext(): Record<string, unknown> {
  return {
    SortableContext: function SortableContext(props: { children?: unknown }) {
      return props.children
    }
  }
}

export function stubTabStripDragScroll(): Record<string, unknown> {
  return {
    useTabStripDragScrollHandlers: () => ({
      isTabDragActive: false,
      onDragScrollStartEnter: vi.fn(),
      onDragScrollEndEnter: vi.fn(),
      onDragScrollLeave: vi.fn()
    })
  }
}

// Return inert tooltip descriptors so shallow walking never invokes hook-based primitives.
export function stubTooltip(): Record<string, unknown> {
  const passthrough = (type: string) =>
    function TooltipPrimitiveStub(props: { children?: unknown }) {
      return { type, props }
    }
  return {
    TooltipProvider: passthrough('TooltipProvider'),
    Tooltip: passthrough('Tooltip'),
    TooltipTrigger: passthrough('TooltipTrigger'),
    TooltipContent: passthrough('TooltipContent')
  }
}

export function stubStatusDisplay(): Record<string, unknown> {
  return { buildStatusMap: () => new Map() }
}

export function stubTabInsertion(): Record<string, unknown> {
  return { resolveTabIndicatorEdges: () => [] }
}

export function stubEditorLabels(): Record<string, unknown> {
  return { getEditorDisplayLabel: () => '' }
}

export function stubSortableTab(): Record<string, unknown> {
  return {
    default: function SortableTab() {
      return null
    }
  }
}

export function stubEditorFileTab(): Record<string, unknown> {
  return {
    default: function EditorFileTab() {
      return null
    }
  }
}

export function stubBrowserTab(): Record<string, unknown> {
  return {
    default: function BrowserTab() {
      return null
    },
    getBrowserTabLabel: () => ''
  }
}

export function stubQuickLaunchButton(): Record<string, unknown> {
  return {
    QuickLaunchAgentMenuItems: function QuickLaunchAgentMenuItems() {
      return null
    },
    ProjectedAgentMenuItems: function ProjectedAgentMenuItems() {
      return null
    },
    useTabAgentMenuLaunch: () => () => undefined
  }
}

export function stubShellIcons(): Record<string, unknown> {
  return {
    ShellIcon: function ShellIcon() {
      return null
    }
  }
}

export function stubFocusTerminalTabSurface(): Record<string, unknown> {
  return { focusTerminalTabSurface: vi.fn() }
}

export function stubDropdownMenu(): Record<string, unknown> {
  return {
    DropdownMenu: function DropdownMenu(props: { children?: unknown }) {
      return { type: 'DropdownMenu', props }
    },
    DropdownMenuContent: function DropdownMenuContent(props: { children?: unknown }) {
      return { type: 'DropdownMenuContent', props }
    },
    DropdownMenuItem: function DropdownMenuItem(props: {
      children?: unknown
      onSelect?: () => void
    }) {
      return { type: 'DropdownMenuItem', props }
    },
    DropdownMenuSeparator: function DropdownMenuSeparator() {
      return { type: 'DropdownMenuSeparator', props: {} }
    },
    DropdownMenuShortcut: function DropdownMenuShortcut(props: { children?: unknown }) {
      return { type: 'DropdownMenuShortcut', props }
    },
    DropdownMenuLabel: function DropdownMenuLabel(props: { children?: unknown }) {
      return { type: 'DropdownMenuLabel', props }
    },
    DropdownMenuSub: function DropdownMenuSub(props: { children?: unknown }) {
      return { type: 'DropdownMenuSub', props }
    },
    DropdownMenuSubContent: function DropdownMenuSubContent(props: { children?: unknown }) {
      return { type: 'DropdownMenuSubContent', props }
    },
    DropdownMenuSubTrigger: function DropdownMenuSubTrigger(props: { children?: unknown }) {
      return { type: 'DropdownMenuSubTrigger', props }
    },
    DropdownMenuTrigger: function DropdownMenuTrigger(props: { children?: unknown }) {
      return { type: 'DropdownMenuTrigger', props }
    }
  }
}
