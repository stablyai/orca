import { workspaceView } from '@/lib/renderer-view'
import { setThreadTestPage } from './thread-page.test-fixture'
import { cleanup, screen } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session-wire'

vi.mock('@/runtime/structured-agent-session-client', async (original) => ({
  ...(await original<object>()),
  structuredAgentSessionHostSupports: async () => true
}))
vi.mock('@/runtime/runtime-rpc-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await original())
)
vi.mock('@/runtime/runtime-layout-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await original())
)
vi.mock('../native-chat/NativeChatView', () => ({
  default: ({ sessionId, isVisible }: { sessionId: string; isVisible: boolean }) => (
    <div data-testid="conversation" hidden={!isVisible}>
      {sessionId}
    </div>
  )
}))
vi.mock('./NewThread', () => ({
  NewThread: ({ draftId }: { draftId: string }) => <div>Draft {draftId}</div>
}))
import { useAppStore } from '@/store'
import { makeWorktree, makeUnifiedTab, makeTabGroup } from '@/store/slices/store-test-helpers'
import { TooltipProvider } from '../ui/tooltip'

import { ThreadSurface, useThreadSurfaceActive } from './ThreadSurface'

import {
  publishStructuredSessionSummaries,
  useStructuredSessionSummaries
} from '../native-chat/structured-session-summary-store'
import StructuredAgentSessionPaneOverlayLayer from '../native-chat/StructuredAgentSessionPaneOverlayLayer'
import { useTabGroupItemProjections } from '../tab-group/useTabGroupItemProjections'

import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'

const W = 'repo::/main'
const ordinary = makeUnifiedTab({
  id: 'ordinary',
  entityId: 'ordinary',
  worktreeId: W,
  groupId: 'g',
  contentType: 'agent-session',
  executionHostId: 'local',
  agentSessionAgent: 'codex'
})
const first = { ...ordinary, id: 'first', entityId: 'first' }
const second = { ...ordinary, id: 'second', entityId: 'second' }
const repo = { id: 'repo', path: '/main', displayName: 'Project', addedAt: 1, badgeColor: '' }
const worktree = makeWorktree({
  id: W,
  repoId: 'repo',
  path: '/main',
  isMainWorktree: true,
  hostId: 'local'
})
function classify(tab: Tab, changes: Partial<AgentSessionStatusSummary> = {}) {
  publishStructuredSessionSummaries([
    {
      tabId: tab.id,
      tab,
      summary: {
        sessionId: tab.entityId,
        workspaceId: W,
        agent: 'codex',
        status: 'idle',
        latestPrompt: tab.id,
        updatedAt: 1,
        surface: 'thread',
        ...changes
      }
    }
  ])
}
function Workbench() {
  const id = useAppStore((s) => s.activeWorktreeId) ?? W
  const groups = useAppStore((s) => s.groupsByWorktree[id]) ?? []
  return (
    <>
      {groups.map((group) => (
        <Strip key={group.id} id={id} groupId={group.id} />
      ))}
      <StructuredAgentSessionPaneOverlayLayer worktreeId={id} isWorktreeActive />
    </>
  )
}
function Strip({ id, groupId }: { id: string; groupId: string }) {
  const groups = useAppStore((s) => s.groupsByWorktree[id])
  const unifiedTabs = useAppStore((s) => s.unifiedTabsByWorktree[id])
  const threadsEnabled = useAppStore((s) => s.settings?.experimentalThreads === true)
  const { groupTabs, activeTab } = useTabGroupItemProjections({
    groupId,
    worktreeId: id,
    worktreeState: {
      groups: groups ?? [],
      unifiedTabs: unifiedTabs ?? [],
      terminalTabs: [],
      openFiles: [],
      browserTabs: [],
      expandedPaneByTabId: {},
      terminalLayoutsByTabId: {},
      threadsEnabled,
      generatedTabTitlesEnabled: false,
      mobileEmulatorEnabled: false
    }
  })
  return (
    <div data-testid={`strip-${groupId}`} data-active={activeTab?.id ?? ''}>
      {groupTabs.map((tab) => (
        <span key={tab.id}>{tab.id}</span>
      ))}
      {!activeTab ? 'Empty workbench' : null}
    </div>
  )
}
function Desktop() {
  const thread = useThreadSurfaceActive()
  const view = useAppStore((s) => workspaceView(s.activeView))
  return (
    <TooltipProvider>
      {view !== 'terminal' ? <div>Settings</div> : thread ? <ThreadSurface /> : <Workbench />}
    </TooltipProvider>
  )
}
function visibleConversation() {
  return screen
    .queryAllByTestId('conversation')
    .filter((node) => !node.hidden && !node.closest('[aria-hidden="true"]'))
    .map((node) => node.textContent)
}
let main: TabsDrawnFromMain
beforeEach(async () => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      runtime: {
        call: vi.fn(async () => ({
          id: 'test',
          ok: true,
          result: null,
          _meta: { runtimeId: 'local' }
        }))
      },
      ui: {
        onSplitTerminal: vi.fn(() => () => {}),
        onRenameTerminal: vi.fn(() => () => {}),
        onFocusTerminal: vi.fn(() => () => {}),
        onFocusEditorTab: vi.fn(() => () => {})
      }
    }
  })
  setThreadTestPage({ selection: null })
  useAppStore.setState({
    settings: { ...useAppStore.getState().settings!, experimentalThreads: true },
    activeView: 'terminal',
    activeWorktreeId: W,
    activeWorkspaceExecutionHostId: 'local',
    activeRepoId: 'repo',
    repos: [repo],
    worktreesByRepo: { repo: [worktree] },
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    unifiedTabsByWorktree: { [W]: [ordinary, first, second] },
    groupsByWorktree: {
      [W]: [
        makeTabGroup({
          id: 'g',
          worktreeId: W,
          activeTabId: first.id,
          tabOrder: ['ordinary', 'first', 'second'],
          recentTabIds: ['first', 'ordinary', 'second']
        })
      ]
    },
    activeGroupIdByWorktree: { [W]: 'g' },
    tabsByWorktree: {},
    activeTabType: 'agent-session',
    setActiveTabType: vi.fn(),
    refreshGitHubForWorktreeIfStale: vi.fn(),
    reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 3 })),
    revealWorktreeInSidebar: vi.fn()
  })
  main = await drawTabsFromMain(useAppStore)
})
afterEach(() => {
  cleanup()
  main.close()
  publishStructuredSessionSummaries(
    [...useStructuredSessionSummaries.getState().threadTabIds].map((tabId) => ({
      tabId,
      summary: null
    }))
  )
})

export function replaceMain(next: TabsDrawnFromMain) {
  main = next
}
export { W, ordinary, first, second, repo, worktree, classify, Desktop, visibleConversation, main }
