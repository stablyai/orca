// @vitest-environment happy-dom

import { act, startTransition, Suspense, use } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearClientHostedBrowserRowSelection,
  getClientHostedBrowserRowSelection,
  selectClientHostedBrowserRow
} from '@/lib/pane-manager/client-hosted-browser-row-state'
import { i18n } from '@/i18n/i18n'
import type { TabBarItem } from './tab-bar-item-model'
import type { WorkspaceVisibleTabType } from '../../../../shared/tab-types'
import {
  renderTabBarItems,
  type TabBarItemSurfaceProps,
  type TabBarItemSurfaceRuntime
} from './tab-bar-item-surface'
import { useTabBarItemActions } from './use-tab-bar-item-actions'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type TabProps = {
  tab?: { id: string; title: string }
  isActive: boolean
  isPinned: boolean
  onActivate: (id: string) => void
  onDuplicate?: () => void
  gitStatus?: string | null
}

// Every render of every tab, in order, keyed by the id the strip shows it under.
const tabRenders: { id: string; props: TabProps }[] = []

vi.mock('./SortableTab', () => ({
  default: (props: TabProps) => {
    tabRenders.push({ id: props.tab!.id, props })
    return null
  }
}))
vi.mock('./BrowserTab', () => ({
  default: (props: TabProps) => {
    tabRenders.push({ id: props.tab!.id, props })
    return null
  },
  getBrowserTabLabel: () => ''
}))
vi.mock('./EditorFileTab', () => ({
  default: (props: TabProps & { file: { id: string } }) => {
    tabRenders.push({ id: props.file.id, props })
    return null
  }
}))

/** Rebuilt on every call, like the strip's projections: equal content, never the same objects. */
function buildItems({ terminalPinned = false, browserTitle = 'Example' } = {}): TabBarItem[] {
  return [
    {
      type: 'terminal',
      id: 'terminal-1',
      unifiedTabId: 'unified-terminal-1',
      isPinned: terminalPinned,
      data: {
        id: 'terminal-1',
        ptyId: null,
        worktreeId: 'wt-1',
        title: 'zsh',
        generatedTitle: 'Fix the login bug',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 0
      }
    },
    {
      type: 'browser',
      id: 'browser-1',
      unifiedTabId: 'unified-browser-1',
      isPinned: false,
      data: {
        id: 'browser-1',
        worktreeId: 'wt-1',
        url: 'https://example.test',
        title: browserTitle,
        loading: false,
        faviconUrl: null,
        canGoBack: false,
        canGoForward: false,
        loadError: null,
        createdAt: 0
      }
    },
    {
      type: 'editor',
      id: 'file-1',
      unifiedTabId: 'unified-file-1',
      isPinned: false,
      data: {
        id: 'file-1',
        filePath: '/repo/notes.md',
        relativePath: 'notes.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        isPreview: false,
        isDirty: false,
        mode: 'edit'
      }
    },
    {
      type: 'agent-session',
      id: 'session-1',
      unifiedTabId: 'session-1',
      isPinned: false,
      data: {
        id: 'session-1',
        entityId: 'session-1',
        groupId: 'group-1',
        worktreeId: 'wt-1',
        contentType: 'agent-session',
        label: 'Session',
        customLabel: null,
        color: null,
        sortOrder: 3,
        createdAt: 0
      }
    }
  ]
}

type StripInputs = {
  onActivate?: (id: string) => void
  generatedTabTitlesEnabled?: boolean
  managedBrowserCreationEnabled?: boolean
  terminalPinned?: boolean
  browserTitle?: string
  activeTabType?: WorkspaceVisibleTabType
  activeClientHostedBrowserRowId?: string | null
  statusByRelativePath?: TabBarItemSurfaceRuntime['statusByRelativePath']
}

function Strip({
  onActivate = NOOP,
  generatedTabTitlesEnabled = false,
  managedBrowserCreationEnabled = false,
  terminalPinned,
  browserTitle,
  activeTabType = 'terminal',
  activeClientHostedBrowserRowId = null,
  statusByRelativePath = STATUS_BY_RELATIVE_PATH
}: StripInputs): React.JSX.Element {
  const props: TabBarItemSurfaceProps = {
    worktreeId: 'wt-1',
    activeTabId: 'terminal-1',
    activeFileId: 'file-1',
    activeBrowserTabId: 'browser-1',
    activeSimulatorTabId: null,
    activeTabType,
    expandedPaneByTabId: {}
  }
  const runtime: TabBarItemSurfaceRuntime = {
    resolvedGroupId: 'group-1',
    generatedTabTitlesEnabled,
    unifiedTabByVisibleId: new Map(),
    pendingChatPairByTabId: {},
    nativeChatEnabled: false,
    tabAgentTypesByTabId: {},
    nativeChatTabWideFallbackUnsafeTabsById: {},
    nativeChatTranscriptIsLocalReadable: false,
    managedBrowserCreationEnabled,
    statusByRelativePath
  }
  const actions = useTabBarItemActions({
    props: {
      onActivate,
      onActivateFile: onActivate,
      onActivateBrowserTab: onActivate,
      onActivateAgentSession: onActivate,
      onClose: NOOP,
      onCloseOthers: NOOP,
      onCloseToRight: NOOP,
      onCloseToLeft: NOOP,
      onSetCustomTitle: NOOP,
      onSetTabColor: NOOP,
      onTogglePaneExpand: NOOP
    },
    togglePinned: NOOP,
    toggleTabViewMode: NOOP
  })
  return (
    <>
      {renderTabBarItems({
        items: buildItems({ terminalPinned, browserTitle }),
        props,
        runtime,
        actions,
        dropIndicatorByVisibleId: new Map(),
        includeTopTabBorder: true,
        activeClientHostedBrowserRowId
      })}
    </>
  )
}

const NOOP = (): void => {}
const STATUS_BY_RELATIVE_PATH: TabBarItemSurfaceRuntime['statusByRelativePath'] = new Map()
const TAB_IDS = ['terminal-1', 'browser-1', 'file-1', 'session-1']
let root: Root | null = null

const NEVER_RESOLVES = new Promise<never>(() => {})

function Suspended(): null {
  use(NEVER_RESOLVES)
  return null
}

function stripTree(inputs: StripInputs, suspended = false): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <Strip {...inputs} />
      {suspended ? <Suspended /> : null}
    </Suspense>
  )
}

function renderStrip(inputs: StripInputs = {}): void {
  if (!root) {
    root = createRoot(document.createElement('div'))
  }
  act(() => root!.render(stripTree(inputs)))
}

function lastRender(tabId: string): TabProps {
  return tabRenders.findLast((render) => render.id === tabId)!.props
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  tabRenders.length = 0
  clearClientHostedBrowserRowSelection()
})

describe('tab strip rows', () => {
  it('skips every tab when the strip re-renders with equal tab content', () => {
    renderStrip()
    expect(tabRenders.map((render) => render.id)).toEqual(TAB_IDS)

    renderStrip({ onActivate: vi.fn() })

    expect(tabRenders).toHaveLength(TAB_IDS.length)
  })

  it('calls the handler the strip has now, from a tab that skipped its render', () => {
    const first = vi.fn()
    const current = vi.fn()
    renderStrip({ onActivate: first })
    renderStrip({ onActivate: current })

    lastRender('terminal-1').onActivate('terminal-1')

    expect(current).toHaveBeenCalledWith('terminal-1')
    expect(first).not.toHaveBeenCalled()
  })

  it('keeps the committed handler when React abandons a render', async () => {
    const committed = vi.fn()
    const abandoned = vi.fn()
    renderStrip({ onActivate: committed })
    await act(async () =>
      startTransition(() => root!.render(stripTree({ onActivate: abandoned }, true)))
    )

    lastRender('terminal-1').onActivate('terminal-1')

    expect(committed).toHaveBeenCalledWith('terminal-1')
    expect(abandoned).not.toHaveBeenCalled()
  })

  it('re-renders every tab when the language is re-applied, as a language-pack reload does', async () => {
    renderStrip()

    await act(() => i18n.changeLanguage(i18n.language))

    expect(tabRenders.map((render) => render.id)).toEqual([...TAB_IDS, ...TAB_IDS])
  })

  it('re-renders a terminal tab when the generated-titles setting changes its title', () => {
    renderStrip()
    expect(lastRender('terminal-1').tab?.title).toBe('zsh')

    renderStrip({ generatedTabTitlesEnabled: true })

    expect(lastRender('terminal-1').tab?.title).toBe('Fix the login bug')
  })

  it('re-renders a browser tab when duplicating becomes available', () => {
    renderStrip()
    expect(lastRender('browser-1').onDuplicate).toBeUndefined()

    renderStrip({ managedBrowserCreationEnabled: true })

    expect(lastRender('browser-1').onDuplicate).toBeTypeOf('function')
  })

  it('re-renders a tab when it is pinned', () => {
    renderStrip()
    expect(lastRender('terminal-1').isPinned).toBe(false)

    renderStrip({ terminalPinned: true })

    expect(lastRender('terminal-1').isPinned).toBe(true)
  })

  it('re-renders only the two tabs a switch moves the active state between', () => {
    renderStrip({ activeTabType: 'terminal' })
    tabRenders.length = 0

    renderStrip({ activeTabType: 'browser' })

    expect(tabRenders.map((render) => render.id)).toEqual(['terminal-1', 'browser-1'])
  })

  it('re-renders a tab when its own data changes', () => {
    renderStrip()

    renderStrip({ browserTitle: 'Renamed page' })

    expect(lastRender('browser-1').tab?.title).toBe('Renamed page')
    expect(tabRenders).toHaveLength(TAB_IDS.length + 1)
  })

  it('re-renders an editor tab only when a git status write changes its own status', () => {
    renderStrip()

    renderStrip({ statusByRelativePath: new Map([['other.md', 'modified']]) })
    expect(tabRenders).toHaveLength(TAB_IDS.length)

    renderStrip({ statusByRelativePath: new Map([['notes.md', 'modified']]) })
    expect(lastRender('file-1').gitStatus).toBe('modified')
    expect(tabRenders).toHaveLength(TAB_IDS.length + 1)
  })

  it.each(TAB_IDS)('retires a client-hosted row selection when %s is activated', (tabId) => {
    renderStrip()
    selectClientHostedBrowserRow({
      worktreeId: 'wt-1',
      browserPageId: 'page-1',
      groupId: 'group-1',
      groupActiveTabIdAtSelection: 'unified-terminal-1'
    })

    lastRender(tabId).onActivate(tabId)

    expect(getClientHostedBrowserRowSelection()).toBeNull()
  })
})

/**
 * A client-hosted row covers the pane without moving the group's `activeTabId`, so the strip's two
 * halves would each keep painting an underline — the reported double highlight.
 */
describe('real tabs while a client-hosted row is selected', () => {
  const activeFlags = (): boolean[] => TAB_IDS.map((tabId) => lastRender(tabId).isActive)

  it.each<WorkspaceVisibleTabType>(['terminal', 'browser', 'editor'])(
    'underlines the %s tab the group is actually showing when no row is selected',
    (activeTabType) => {
      renderStrip({ activeTabType })
      expect(activeFlags().filter(Boolean)).toHaveLength(1)
    }
  )

  it.each<WorkspaceVisibleTabType>(['terminal', 'browser', 'editor'])(
    'renders the %s tab inactive while a row owns the pane',
    (activeTabType) => {
      renderStrip({ activeTabType, activeClientHostedBrowserRowId: 'page-1' })
      expect(activeFlags()).toEqual([false, false, false, false])
    }
  )
})
