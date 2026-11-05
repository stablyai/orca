// @vitest-environment happy-dom

import { act, startTransition, Suspense, use } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import { useNativeChatToggleShortcut } from '../native-chat/use-native-chat-toggle-shortcut'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearClientHostedBrowserRowSelection } from '@/lib/pane-manager/client-hosted-browser-row-state'

import type { TabBarItem } from './tab-bar-item-model'
import type { WorkspaceVisibleTabType } from '../../../../shared/tab-types'
import type { AppState } from '@/store/types'
import { createTestStore } from '@/store/slices/store-test-helpers'
import {
  makeGroup,
  makeRepo,
  makeWorktree,
  makeTerminalTab,
  makeUnifiedTab
} from '../worktree-jump/worktree-jump-palette-test-fixtures'
import { selectNativeChatWslProject } from '../terminal-pane/terminal-pane-host-state'
import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import {
  renderTabBarItems,
  type TabBarItemSurfaceProps,
  type TabBarItemSurfaceRuntime
} from './tab-bar-item-surface'
import { useTabBarItemActions } from './use-tab-bar-item-actions'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@/store/plugin-panels', () => ({ usePluginCommands: () => [] }))
vi.mock('@/lib/shortcut-platform', () => ({ getShortcutPlatform: () => 'win32' }))
vi.mock('@/lib/renderer-app-platform', () => ({ getRendererAppPlatform: () => 'win32' }))
const menuToggle = vi.fn()

type TabProps = {
  tab?: { id: string; title: string }
  agent?: string | null
  nativeChat?: { sessionId: string; agent: string | undefined }
  isActive: boolean
  isPinned: boolean
  onActivate: (id: string) => void
  onDuplicate?: () => void
  gitStatus?: string | null
  canToggleViewMode?: boolean
  onToggleViewMode?: () => void
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
  nativeChatState?: AppState
  nativeChatAgent?: AgentType
  chatMode?: boolean
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
  nativeChatState,
  nativeChatAgent,
  chatMode = false,
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
    unifiedTabByVisibleId: nativeChatState
      ? new Map([
          [
            'terminal-1',
            {
              id: 'unified-terminal-1',
              entityId: 'terminal-1',
              contentType: 'terminal',
              groupId: 'group-1',
              worktreeId: 'wt-1',
              label: 'codex',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 0,
              viewMode: chatMode ? 'chat' : 'terminal'
            }
          ]
        ])
      : new Map(),
    tabAgentTypesByTabId: nativeChatAgent ? { 'terminal-1': nativeChatAgent } : {},
    nativeChatTabWideFallbackUnsafeTabsById: {},
    nativeChatIsWslProject: nativeChatState
      ? selectNativeChatWslProject(nativeChatState, 'wt-1')
      : false,
    nativeChatTranscriptIsLocalReadable: Boolean(nativeChatState),
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
    toggleTabViewMode: menuToggle
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
it.each([true, false, null])(
  'gates the tab menu from addressed runtime facts and keeps Return (%s)',
  (runtime) => {
    const state: AppState = {
      ...createTestStore().getState(),
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      repos: [{ ...makeRepo(), id: 'repo', executionHostId: 'local' }],
      projects: [],
      settings: null,
      worktreesByRepo:
        runtime === null
          ? {}
          : {
              repo: [
                makeWorktree('wt-1', 'Main', {
                  repoId: 'repo',
                  hostId: 'local',
                  path: runtime ? '//wsl.localhost/Ubuntu/work' : 'C:/work'
                })
              ]
            }
    }
    renderStrip({ nativeChatState: state, nativeChatAgent: 'codex' })
    expect(lastRender('terminal-1').canToggleViewMode).toBe(runtime === true)
    renderStrip({ nativeChatState: state, nativeChatAgent: 'zcode' })
    expect(lastRender('terminal-1').canToggleViewMode).toBe(false)
    renderStrip({ nativeChatState: state, nativeChatAgent: 'zcode', chatMode: true })
    expect(lastRender('terminal-1').canToggleViewMode).toBe(true)
    lastRender('terminal-1').onToggleViewMode?.()
    expect(menuToggle).toHaveBeenCalledWith('unified-terminal-1')
  }
)

it.each([true, false, null])(
  'uses runtime facts for shortcut entry and always allows return (%s)',
  (runtime) => {
    const previous = useAppStore.getState()
    const tab = makeUnifiedTab('tab', 'wt', 'tab', 'codex')
    useAppStore.setState({
      ...createTestStore().getState(),
      tabsByWorktree: { wt: [makeTerminalTab('tab', 'wt', 'codex')] },
      activeWorktreeId: 'wt',
      activeGroupIdByWorktree: { wt: 'group-wt' },
      activeWorkspaceExecutionHostId: 'local',
      groupsByWorktree: { wt: [makeGroup('wt', [tab.id])] },
      repos: [{ ...makeRepo(), id: 'repo', executionHostId: 'local' }],
      projects: [],
      worktreesByRepo:
        runtime === null
          ? {}
          : {
              repo: [
                makeWorktree('wt', 'Main', {
                  repoId: 'repo',
                  hostId: 'local',
                  path: runtime ? '//wsl.localhost/Ubuntu/work' : 'C:/work'
                })
              ]
            },
      unifiedTabsByWorktree: { wt: [{ ...tab, viewMode: 'terminal' }] },
      agentStatusByPaneKey: {
        [`tab:${LEFT}`]: {
          state: 'waiting',
          prompt: '',
          updatedAt: 0,
          stateStartedAt: 0,
          paneKey: `tab:${LEFT}`,
          agentType: 'codex'
        }
      }
    })
    try {
      renderHook(() => useNativeChatToggleShortcut('wt', true))
      const press = () => {
        const event = new KeyboardEvent('keydown', {
          key: 'F11',
          code: 'F11',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
        act(() => document.body.dispatchEvent(event))
        return event.defaultPrevented
      }
      expect(press()).toBe(runtime === true)
      expect(useAppStore.getState().unifiedTabsByWorktree.wt[0].viewMode).toBe(
        runtime === true ? 'chat' : 'terminal'
      )
      act(() => useAppStore.getState().setTabViewMode(tab.id, 'chat'))
      expect(press()).toBe(true)
      expect(useAppStore.getState().unifiedTabsByWorktree.wt[0].viewMode).toBe('terminal')
    } finally {
      cleanup()
      useAppStore.setState(previous, true)
    }
  }
)
