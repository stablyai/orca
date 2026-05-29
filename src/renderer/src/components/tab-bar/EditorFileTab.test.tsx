import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '../../store/slices/editor'

const reactHookRuntime = vi.hoisted(() => ({
  states: [] as unknown[],
  index: 0
}))

const appStoreMocks = vi.hoisted(() => ({
  openMarkdownPreview: vi.fn(),
  getState: vi.fn(() => ({
    settings: {}
  }))
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    useEffect: () => {},
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
  Copy: function Copy(props: Record<string, unknown>) {
    return { type: 'Copy', props }
  },
  ExternalLink: function ExternalLink(props: Record<string, unknown>) {
    return { type: 'ExternalLink', props }
  },
  Eye: function Eye(props: Record<string, unknown>) {
    return { type: 'Eye', props }
  },
  GitCompareArrows: function GitCompareArrows(props: Record<string, unknown>) {
    return { type: 'GitCompareArrows', props }
  },
  Pencil: function Pencil(props: Record<string, unknown>) {
    return { type: 'Pencil', props }
  },
  Rows2: function Rows2(props: Record<string, unknown>) {
    return { type: 'Rows2', props }
  },
  ShieldAlert: function ShieldAlert(props: Record<string, unknown>) {
    return { type: 'ShieldAlert', props }
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

vi.mock('@/components/editor/editor-labels', () => ({
  getEditorDisplayLabel: (file: OpenFile) => file.relativePath
}))

vi.mock('@/lib/rename-file', () => ({
  renameFileOnDisk: vi.fn()
}))

vi.mock('@/lib/file-type-icons', () => ({
  getFileTypeIcon: () =>
    function FileIcon(props: Record<string, unknown>) {
      return { type: 'FileIcon', props }
    }
}))

vi.mock('@/store/selectors', () => ({
  useRepoById: () => ({ connectionId: null }),
  useWorktreeById: () => ({ path: '/repo', repoId: 'repo-1' })
}))

vi.mock('@/store', () => {
  const useAppStore = (selector: (state: { openMarkdownPreview: typeof vi.fn }) => unknown) =>
    selector({ openMarkdownPreview: appStoreMocks.openMarkdownPreview })
  useAppStore.getState = appStoreMocks.getState
  return { useAppStore }
})

vi.mock('../right-sidebar/status-display', () => ({
  STATUS_COLORS: {},
  STATUS_LABELS: {}
}))

vi.mock('./SortableTab', () => ({
  CLOSE_ALL_CONTEXT_MENUS_EVENT: 'orca-close-all-context-menus'
}))

vi.mock('./drop-indicator', () => ({
  ACTIVE_TAB_INDICATOR_CLASSES: 'active-tab-indicator',
  getDropIndicatorClasses: () => ''
}))

vi.mock('@/components/editor/markdown-preview-controls', () => ({
  canOpenMarkdownPreview: () => false
}))

vi.mock('@/lib/local-path-open-guard', () => ({
  shouldBlockEditorTabLocalOpen: () => false,
  showLocalPathOpenBlockedToast: vi.fn()
}))

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function baseFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: '/repo/untitled-5.md',
    filePath: '/repo/untitled-5.md',
    relativePath: 'untitled-5.md',
    worktreeId: 'wt-1',
    language: 'markdown',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

async function renderEditorFileTab(
  file: OpenFile,
  onActivate = vi.fn()
): Promise<{ element: unknown; onActivate: ReturnType<typeof vi.fn> }> {
  reactHookRuntime.index = 0
  const module = await import('./EditorFileTab')
  const element = module.default({
    file,
    isActive: true,
    hasTabsToRight: false,
    statusByRelativePath: new Map(),
    onActivate,
    onClose: () => {},
    onCloseToRight: () => {},
    onCloseAll: () => {},
    onPin: () => {},
    onSplitGroup: () => {},
    dragData: {
      kind: 'tab',
      worktreeId: file.worktreeId,
      groupId: 'group-1',
      unifiedTabId: file.id,
      visibleTabId: file.id,
      tabType: 'editor',
      label: file.relativePath,
      iconPath: file.filePath
    }
  })
  return { element, onActivate }
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

function getText(node: unknown): string {
  if (node == null) {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(getText).join('')
  }
  const el = node as ReactElementLike
  return getText(el.props?.children)
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

function findMenuItemByText(node: unknown, label: string): ReactElementLike {
  const item = findElementsByType(node, 'DropdownMenuItem').find((candidate) =>
    getText(candidate).includes(label)
  )
  if (!item) {
    throw new Error(`Missing menu item: ${label}`)
  }
  return item
}

describe('EditorFileTab rename menu', () => {
  beforeEach(() => {
    reactHookRuntime.states = []
    reactHookRuntime.index = 0
    vi.clearAllMocks()
    vi.resetModules()
    vi.stubGlobal('navigator', { userAgent: 'Mac' })
  })

  it('turns the tab filename into an inline input from the Rename context-menu item', async () => {
    const onActivate = vi.fn()
    const file = baseFile({ isUntitled: true })
    const firstRender = expandNode((await renderEditorFileTab(file, onActivate)).element)
    const renameItem = findMenuItemByText(firstRender, 'Rename')

    // Why: New Markdown tabs are real on-disk files even while marked
    // isUntitled; the tab menu must let users rename the screenshot-style
    // "untitled-N.md" files directly.
    expect(renameItem.props.disabled).toBe(false)
    ;(renameItem.props.onSelect as () => void)()

    const secondRender = expandNode((await renderEditorFileTab(file, onActivate)).element)
    const inputs = findElementsByType(secondRender, 'input')
    expect(inputs).toHaveLength(1)
    expect(inputs[0].props.defaultValue).toBe('untitled-5.md')
    expect(inputs[0].props['data-tab-rename-input']).toBe('true')
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it('disables Rename for diff tabs that do not map to one writable file', async () => {
    const file = baseFile({
      mode: 'diff',
      diffSource: 'unstaged'
    })
    const element = expandNode((await renderEditorFileTab(file)).element)
    const renameItem = findMenuItemByText(element, 'Rename')

    expect(renameItem.props.disabled).toBe(true)
  })
})
