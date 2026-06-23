import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const shortcutLabelMock = vi.hoisted(() => vi.fn(() => '⌘⌥W'))

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
}))

vi.mock('lucide-react', () => ({
  Copy: function Copy(props: Record<string, unknown>) {
    return { type: 'Copy', props }
  },
  ExternalLink: function ExternalLink(props: Record<string, unknown>) {
    return { type: 'ExternalLink', props }
  },
  Columns2: function Columns2(props: Record<string, unknown>) {
    return { type: 'Columns2', props }
  },
  Rows2: function Rows2(props: Record<string, unknown>) {
    return { type: 'Rows2', props }
  },
  Pencil: function Pencil(props: Record<string, unknown>) {
    return { type: 'Pencil', props }
  },
  Pin: function Pin(props: Record<string, unknown>) {
    return { type: 'Pin', props }
  },
  PinOff: function PinOff(props: Record<string, unknown>) {
    return { type: 'PinOff', props }
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

// Why: the menu reads the live binding for tab.closeAll; stub it to a fixed
// label so the test asserts the shortcut is surfaced, not its platform glyphs.
vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: shortcutLabelMock
}))

const useAppStoreMock = Object.assign(
  (
    selector: (state: {
      settings: Record<string, unknown>
      unifiedTabsByWorktree: Record<string, unknown[]>
      groupsByWorktree: Record<string, unknown[]>
    }) => unknown
  ) =>
    selector({
      settings: {},
      unifiedTabsByWorktree: {
        'wt-1': [{ id: 'tab-1', groupId: 'group-1' }]
      },
      groupsByWorktree: {
        'wt-1': [{ id: 'group-1', tabOrder: ['tab-1', 'tab-2'] }]
      }
    }),
  {
    getState: () => ({
      settings: {},
      unifiedTabsByWorktree: {
        'wt-1': [{ id: 'tab-1', groupId: 'group-1' }]
      },
      groupsByWorktree: {
        'wt-1': [{ id: 'group-1', tabOrder: ['tab-1', 'tab-2'] }]
      }
    })
  }
)

vi.mock('@/store', () => ({
  useAppStore: useAppStoreMock
}))

vi.mock('@/lib/local-path-open-guard', () => ({
  showLocalPathOpenBlockedToast: vi.fn()
}))

vi.mock('./editor-tab-local-open-guard', () => ({
  shouldBlockEditorTabLocalOpen: () => false
}))

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
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
    return expandNode((el.type as (props: unknown) => unknown)(el.props))
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

function extractText(node: unknown): string {
  if (node == null) {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(extractText).join('')
  }
  const el = node as ReactElementLike
  return el.props && 'children' in el.props ? extractText(el.props.children) : ''
}

async function renderMenu(): Promise<unknown> {
  const module = await import('./EditorFileTabContextMenu')
  return module.EditorFileTabContextMenu({
    open: true,
    menuPoint: { x: 0, y: 0 },
    file: {
      id: 'file-1',
      tabId: 'tab-1',
      filePath: '/repo/foo.ts',
      relativePath: 'foo.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      isDirty: false,
      mode: 'edit'
    },
    unifiedTabId: 'tab-1',
    groupId: 'group-1',
    isPinned: false,
    isRenaming: false,
    hasTabsToRight: false,
    canRename: true,
    canShowMarkdownPreview: false,
    resolvedLanguage: 'typescript',
    repoConnectionId: null,
    skipMenuFocusRestoreRef: { current: false },
    onOpenChange: vi.fn(),
    onActivate: vi.fn(),
    onOpenRenameInput: vi.fn(),
    onTogglePin: vi.fn(),
    onClose: vi.fn(),
    onCloseAll: vi.fn(),
    onCloseToRight: vi.fn(),
    onOpenMarkdownPreview: vi.fn()
  })
}

describe('EditorFileTabContextMenu close-all shortcut', () => {
  beforeEach(() => {
    vi.resetModules()
    shortcutLabelMock.mockReturnValue('⌘⌥W')
    vi.stubGlobal('navigator', { userAgent: 'Mac' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the tab.closeAll shortcut next to Close All Editor Tabs', async () => {
    const tree = expandNode(await renderMenu())

    const closeAllItem = findElementsByType(tree, 'DropdownMenuItem').find((item) =>
      extractText(item.props.children).includes('Close All Editor Tabs')
    )

    expect(closeAllItem).toBeTruthy()

    const shortcut = findElementsByType(closeAllItem, 'DropdownMenuShortcut')
    expect(shortcut).toHaveLength(1)
    expect(extractText(shortcut[0].props.children)).toBe('⌘⌥W')

    // Why: the shortcut hint is exclusive to Close All; sibling items (Close,
    // Close Tabs To The Right) must not sprout their own chips.
    expect(findElementsByType(tree, 'DropdownMenuShortcut')).toHaveLength(1)
  })

  it('hides the shortcut chip when close-all is unassigned', async () => {
    shortcutLabelMock.mockReturnValue('Unassigned')

    const tree = expandNode(await renderMenu())

    const closeAllItem = findElementsByType(tree, 'DropdownMenuItem').find((item) =>
      extractText(item.props.children).includes('Close All Editor Tabs')
    )

    expect(closeAllItem).toBeTruthy()
    expect(findElementsByType(closeAllItem, 'DropdownMenuShortcut')).toHaveLength(0)
    expect(findElementsByType(tree, 'DropdownMenuShortcut')).toHaveLength(0)
  })
})
