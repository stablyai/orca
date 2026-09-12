import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  stubBrowserTab,
  stubDropdownMenu,
  stubEditorFileTab,
  stubEditorLabels,
  stubFocusTerminalTabSurface,
  stubHeadlessReact,
  stubQuickLaunchButton,
  stubShallowSelector,
  stubShellIcons,
  stubSortableContext,
  stubSortableTab,
  stubStatusDisplay,
  stubTabInsertion,
  stubTabStripDragScroll
} from './tab-bar-windows-shell-launch-render-stubs'
import {
  resetAppStoreSnapshot,
  useAppStoreExport
} from './tab-bar-windows-shell-launch-test-harness'
import type { ClientHostedBrowserRowSelection } from '@/lib/pane-manager/client-hosted-browser-row-state'

vi.mock('react', async () => await stubHeadlessReact())
vi.mock('zustand/react/shallow', () => stubShallowSelector())
vi.mock('lucide-react', async () => (await import('./lucide-icon-stub-fixture')).stubEveryIcon())
vi.mock('@dnd-kit/sortable', () => stubSortableContext())
vi.mock('./tab-strip-drag-scroll', () => stubTabStripDragScroll())
vi.mock('../../store', () => ({ useAppStore: useAppStoreExport }))
vi.mock('../right-sidebar/status-display', () => stubStatusDisplay())
vi.mock('../tab-group/tab-insertion', () => stubTabInsertion())
vi.mock('@/components/editor/editor-labels', () => stubEditorLabels())
vi.mock('./SortableTab', () => stubSortableTab())
vi.mock('./EditorFileTab', () => stubEditorFileTab())
vi.mock('./BrowserTab', () => stubBrowserTab())
vi.mock('./QuickLaunchButton', () => stubQuickLaunchButton())
vi.mock('./shell-icons', () => stubShellIcons())
vi.mock('@/lib/focus-terminal-tab-surface', () => stubFocusTerminalTabSurface())
vi.mock('@/components/ui/dropdown-menu', () => stubDropdownMenu())

const TERMINAL_TAB = {
  id: 'term-1',
  unifiedTabId: 'unified-term-1',
  ptyId: null,
  worktreeId: 'wt-1',
  title: 'Terminal',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
}

function findByComponentName(node: unknown, name: string): Record<string, unknown> | null {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return null
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByComponentName(child, name)
      if (found) {
        return found
      }
    }
    return null
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> }
  const type = el.type as { name?: string } | string | undefined
  if ((typeof type === 'string' ? type : type?.name) === name) {
    return el.props ?? {}
  }
  return findByComponentName(el.props?.children, name)
}

// Why dynamic: `vi.resetModules()` rebuilds the registry per test, so a static import would write
// the selection into a different copy of the module than the TabBar under test reads.
async function selectRow(selection: ClientHostedBrowserRowSelection): Promise<void> {
  const state = await import('@/lib/pane-manager/client-hosted-browser-row-state')
  state.selectClientHostedBrowserRow(selection)
}

async function renderTerminalStrip(): Promise<Record<string, unknown> | null> {
  const tabBarModule = await import('./TabBar')
  const candidate = tabBarModule.default as unknown as
    | ((props: Record<string, unknown>) => unknown)
    | { type: (props: Record<string, unknown>) => unknown }
  const TabBar = typeof candidate === 'function' ? candidate : candidate.type
  return findByComponentName(
    TabBar({
      tabs: [TERMINAL_TAB],
      editorFiles: [],
      browserTabs: [],
      tabBarOrder: ['term-1'],
      worktreeId: 'wt-1',
      groupId: 'group-1',
      activeTabId: 'term-1',
      activeTabType: 'terminal',
      groupActiveTabId: 'unified-term-1',
      expandedPaneByTabId: {},
      onActivate: () => {},
      onClose: () => {},
      onCloseOthers: () => {},
      onCloseToRight: () => {},
      onCloseToLeft: () => {},
      onNewTerminalTab: () => {},
      onNewBrowserTab: () => {},
      onSetCustomTitle: () => {},
      onSetTabColor: () => {},
      onTogglePaneExpand: () => {}
    }),
    'SortableTab'
  )
}

/**
 * The row-level and helper-level suites both reach the derived id directly, so neither notices if
 * the production TabBar stops asking for it — which is the whole fix. Render the shipping component.
 */
describe('TabBar client-hosted row active state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    resetAppStoreSnapshot()
    vi.stubGlobal('navigator', { userAgent: 'Mac' })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('underlines the terminal tab the group is showing when no row is selected', async () => {
    expect((await renderTerminalStrip())?.isActive).toBe(true)
  })

  it('drops the terminal tab underline while a client-hosted row owns the strip', async () => {
    await selectRow({
      worktreeId: 'wt-1',
      browserPageId: 'page-1',
      groupId: 'group-1',
      groupActiveTabIdAtSelection: 'unified-term-1'
    })

    expect((await renderTerminalStrip())?.isActive).toBe(false)
  })

  it('leaves a strip in another group alone', async () => {
    await selectRow({
      worktreeId: 'wt-1',
      browserPageId: 'page-1',
      groupId: 'group-2',
      groupActiveTabIdAtSelection: 'unified-term-1'
    })

    expect((await renderTerminalStrip())?.isActive).toBe(true)
  })
})
