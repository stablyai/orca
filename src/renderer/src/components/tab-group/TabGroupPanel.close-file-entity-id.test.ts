import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Regression for #16205: a document (editor) tab's X button / "Close" menu item /
// Cmd+W silently no-oped. TabGroupPanel wired onCloseFile straight to
// commands.closeItem, which only matches a unified tab by its own id
// (groupTabs.find(candidate => candidate.id === itemId)) — unlike every sibling
// close handler in this file (onClose, onCloseOthers, onCloseToRight,
// onCloseToLeft, onCloseBrowserTab), which all resolve the incoming id through
// resolveGroupTabFromVisibleId first, because callers can emit either the
// unified tab id or the file's entityId. This test drives onCloseFile with the
// file's entityId (the shape a file-explorer/palette close path emits) and
// asserts the tab actually closes.

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports
  return {
    ...actual,
    useCallback: <T>(callback: T) => callback,
    useMemo: <T>(factory: () => T) => factory()
  }
})

vi.mock('zustand/react/shallow', () => ({
  useShallow: <T>(selector: T) => selector
}))

import { createTestStore } from '../../store/slices/store-test-helpers'

const realStoreBox: { store: ReturnType<typeof createTestStore> | null } = { store: null }

vi.mock('../../store', () => {
  const useAppStore = Object.assign(
    (selector: (state: unknown) => unknown) => selector(realStoreBox.store!.getState()),
    { getState: () => realStoreBox.store!.getState() }
  )
  return { useAppStore }
})

vi.mock('@dnd-kit/core', () => ({
  useDroppable: () => ({ setNodeRef: vi.fn() })
}))

vi.mock('@/lib/lazy-with-retry', () => ({
  lazyWithRetry: () =>
    function EditorPanelStub() {
      return null
    }
}))

vi.mock('../terminal/terminal-tab-actions', () => ({
  closeTerminalTab: vi.fn()
}))

vi.mock('../tab-bar/TabBar', () => ({
  default: function TabBar(props: Record<string, unknown>) {
    return { type: 'TabBar', props }
  }
}))

vi.mock('../tab-bar/TabBarQuickCommandsButton', () => ({
  TabBarQuickCommandsButton: function TabBarQuickCommandsButton() {
    return null
  }
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: function DropdownMenu() {
    return null
  },
  DropdownMenuContent: function DropdownMenuContent() {
    return null
  },
  DropdownMenuItem: function DropdownMenuItem() {
    return null
  },
  DropdownMenuTrigger: function DropdownMenuTrigger() {
    return null
  }
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: function Tooltip() {
    return null
  },
  TooltipContent: function TooltipContent() {
    return null
  },
  TooltipTrigger: function TooltipTrigger() {
    return null
  }
}))

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function findChildByType(node: unknown, typeName: string): ReactElementLike | null {
  if (node == null || typeof node !== 'object') {
    return null
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findChildByType(child, typeName)
      if (found) {
        return found
      }
    }
    return null
  }
  const el = node as ReactElementLike
  const type = el.type as { name?: string } | string | undefined
  const matchedName = typeof type === 'string' ? type : type?.name
  if (matchedName === typeName) {
    return el
  }
  if (el.props && 'children' in el.props) {
    return findChildByType(el.props.children, typeName)
  }
  return null
}

const WT = 'repo1::/tmp/feature'

describe('TabGroupPanel onCloseFile id resolution', () => {
  beforeEach(() => {
    realStoreBox.store = createTestStore()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('closes a document tab when onCloseFile is invoked with the file entityId, not just the unifiedTabId', async () => {
    const store = realStoreBox.store!
    store.getState().openFile({
      worktreeId: WT,
      filePath: '/tmp/feature/NOTES.md',
      relativePath: 'NOTES.md',
      language: 'markdown',
      mode: 'edit'
    } as never)

    const groupId = store.getState().groupsByWorktree[WT][0].id
    const unifiedTab = store.getState().unifiedTabsByWorktree[WT][0]
    expect(unifiedTab.contentType).toBe('editor')
    expect(unifiedTab.entityId).toBe('/tmp/feature/NOTES.md')
    // Sanity: the unified tab's own id is NOT the file entityId (it's a fresh uuid),
    // so a strict id-only match would miss it.
    expect(unifiedTab.id).not.toBe(unifiedTab.entityId)

    const { default: TabGroupPanel } = await import('./TabGroupPanel')
    const element = (TabGroupPanel as unknown as (props: Record<string, unknown>) => unknown)({
      groupId,
      worktreeId: WT,
      isVisible: true,
      isFocused: true,
      hasSplitGroups: false,
      touchesRightEdge: true,
      touchesLeftEdge: true,
      reserveClosedExplorerToggleSpace: false,
      reserveCollapsedSidebarHeaderSpace: false
    })

    const tabBarElement = findChildByType(element, 'TabBar')
    expect(tabBarElement).toBeTruthy()
    const onCloseFile = tabBarElement!.props.onCloseFile as (id: string) => void

    // Drive the handler with the file's entityId (what a file-explorer/palette
    // close, or any caller that isn't the tab-strip X, would emit).
    onCloseFile(unifiedTab.entityId)

    const after = store.getState()
    expect(after.unifiedTabsByWorktree[WT] ?? []).toHaveLength(0)
    expect(after.openFiles).toHaveLength(0)
  })
})
