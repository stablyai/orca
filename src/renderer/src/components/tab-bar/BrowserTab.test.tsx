import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserTab as BrowserTabState } from '../../../../shared/types'

const reactHookRuntime = vi.hoisted(() => ({
  states: [] as unknown[],
  index: 0
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    useEffect: () => {},
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
  Copy: function Copy(props: Record<string, unknown>) {
    return { type: 'Copy', props }
  },
  ExternalLink: function ExternalLink(props: Record<string, unknown>) {
    return { type: 'ExternalLink', props }
  },
  Globe: function Globe(props: Record<string, unknown>) {
    return { type: 'Globe', props }
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
    return { type: 'DropdownMenuTrigger', props }
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

vi.mock('../browser-pane/browser-runtime', () => ({
  getLiveBrowserUrl: () => null
}))

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function baseBrowserTab(overrides: Partial<BrowserTabState> = {}): BrowserTabState {
  return {
    id: 'browser-1',
    worktreeId: 'wt-1',
    label: 'Browser 1',
    sessionProfileId: null,
    activePageId: 'page-1',
    pageIds: ['page-1'],
    url: 'https://example.com/',
    title: 'Example',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0,
    ...overrides
  }
}

async function renderBrowserTab(tab: BrowserTabState): Promise<unknown> {
  reactHookRuntime.index = 0
  const module = await import('./BrowserTab')
  return module.default({
    tab,
    isActive: true,
    isPinned: false,
    hasTabsToRight: false,
    onActivate: () => {},
    onClose: () => {},
    onCloseToRight: () => {},
    onSplitGroup: () => {},
    onDuplicate: () => {},
    onTogglePin: () => {},
    dragData: {
      kind: 'tab',
      worktreeId: tab.worktreeId,
      groupId: 'group-1',
      unifiedTabId: tab.id,
      visibleTabId: tab.id,
      tabType: 'browser',
      label: tab.title
    },
    dropIndicator: undefined
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

async function renderExpandedBrowserTab(tab: BrowserTabState): Promise<unknown> {
  return expandNode(await renderBrowserTab(tab))
}

describe('BrowserTab favicon', { timeout: 10_000 }, () => {
  beforeEach(() => {
    reactHookRuntime.states = []
    reactHookRuntime.index = 0
    vi.clearAllMocks()
  })

  it('renders the favicon image when faviconUrl is present', async () => {
    const iconUrl = 'https://example.com/favicon.ico'
    const element = await renderExpandedBrowserTab(baseBrowserTab({ faviconUrl: iconUrl }))

    const images = findElementsByType(element, 'img')
    expect(images).toHaveLength(1)
    expect(images[0].props.src).toBe(iconUrl)
    expect(images[0].props.alt).toBe('')
    expect(images[0].props['aria-hidden']).toBe(true)
    expect(images[0].props.draggable).toBe(false)
    expect(images[0].props.className).toContain('size-3 mr-1 shrink-0')
    expect(images[0].props.className).toContain('object-contain')
    expect(images[0].props.className).toContain('drop-shadow-[0_0_1px_var(--foreground)]')
    expect(findElementsByType(element, 'Globe')).toHaveLength(0)
  })

  it('keeps the globe fallback for blank tabs without faviconUrl', async () => {
    const element = await renderExpandedBrowserTab(
      baseBrowserTab({
        url: 'about:blank',
        title: 'about:blank',
        faviconUrl: null
      })
    )

    expect(findElementsByType(element, 'img')).toHaveLength(0)
    const globes = findElementsByType(element, 'Globe')
    expect(globes).toHaveLength(1)
    expect(globes[0].props.className).toContain('size-3 mr-1 shrink-0')
    expect(globes[0].props.className).toContain('text-blue-500')
  })

  it('falls back to the globe after the favicon image errors', async () => {
    const tab = baseBrowserTab({ faviconUrl: 'https://example.com/favicon.ico' })
    const firstRender = await renderExpandedBrowserTab(tab)
    const image = findElementsByType(firstRender, 'img')[0]

    ;(image.props.onError as () => void)()
    const secondRender = await renderExpandedBrowserTab(tab)

    expect(findElementsByType(secondRender, 'img')).toHaveLength(0)
    expect(findElementsByType(secondRender, 'Globe')).toHaveLength(1)
  })

  it('resets the image-error fallback when faviconUrl changes', async () => {
    const tab = baseBrowserTab({ faviconUrl: 'https://example.com/favicon.ico' })
    const firstRender = await renderExpandedBrowserTab(tab)
    const image = findElementsByType(firstRender, 'img')[0]

    ;(image.props.onError as () => void)()
    const failedRender = await renderExpandedBrowserTab(tab)
    expect(findElementsByType(failedRender, 'Globe')).toHaveLength(1)

    const nextIconUrl = 'data:image/png;base64,abc123'
    const resetRender = await renderExpandedBrowserTab(
      baseBrowserTab({ id: tab.id, faviconUrl: nextIconUrl })
    )

    const images = findElementsByType(resetRender, 'img')
    expect(images).toHaveLength(1)
    expect(images[0].props.src).toBe(nextIconUrl)
    expect(findElementsByType(resetRender, 'Globe')).toHaveLength(0)
  })
})
