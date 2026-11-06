// @vitest-environment happy-dom

import { act, startTransition, Suspense, use } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearClientHostedBrowserRowSelection } from '@/lib/pane-manager/client-hosted-browser-row-state'

import type { TabBarItem } from './tab-bar-item-model'
import type { WorkspaceVisibleTabType } from '../../../../shared/tab-types'
import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import {
  renderTabBarItems,
  type TabBarItemSurfaceProps,
  type TabBarItemSurfaceRuntime
} from './tab-bar-item-surface'
import { useTabBarItemActions } from './use-tab-bar-item-actions'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type TabProps = {
  tab?: { id: string; title: string }
  agent?: string | null
  nativeChat?: { sessionId: string; agent: string | undefined }
  isActive: boolean
  isPinned: boolean
  onActivate: (id: string) => void
  onDuplicate?: () => void
  gitStatus?: string | null
}

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
function buildItems({
  terminalPinned = false,
  browserTitle = 'Example',
  sessionLabel = 'Session',
  sessionAgent
}: {
  terminalPinned?: boolean
  browserTitle?: string
  sessionLabel?: string
  sessionAgent?: AgentType
} = {}): TabBarItem[] {
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
        ...(sessionAgent ? { agentSessionAgent: sessionAgent } : {}),
        label: sessionLabel,
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
  sessionLabel?: string
  sessionAgent?: AgentType
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
  sessionLabel,
  sessionAgent,
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
    tabAgentTypesByTabId: {},
    nativeChatTabWideFallbackUnsafeTabsById: {},
    nativeChatTranscriptIsLocalReadable: false,
    managedBrowserCreationEnabled,
    statusByRelativePath
  }
  const actions = useTabBarItemActions({
    props: {
      worktreeId: 'wt-1',
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
        items: buildItems({ terminalPinned, browserTitle, sessionLabel, sessionAgent }),
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
})

/** Client-hosted rows overlay panes without changing activeTabId; suppress real-tab underlines while they are selected. */
