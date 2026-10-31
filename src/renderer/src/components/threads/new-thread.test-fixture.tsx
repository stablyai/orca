import { setThreadTestPage } from './thread-page.test-fixture'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, vi } from 'vitest'

import type { TabGroup } from '../../../../shared/tab-types'

import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { promptEditor } from '../native-chat/native-chat-prompt-editor.test-support'
import { TooltipProvider } from '../ui/tooltip'
import { useDesktopVisibleGroups } from './use-desktop-tab-projection'
import { useDesktopThreadPage } from './use-desktop-thread-page'
import { ThreadSurface } from './ThreadSurface'

import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
import {
  useStructuredSessionSummaries,
  publishStructuredSessionSummaries
} from '../native-chat/structured-session-summary-store'

import { NewThread } from './NewThread'
import { ThreadsSection } from './ThreadsSection'
import { useGlobalKeybindings } from '@/app-shell/use-global-keybindings'
import { useAppChromeLayout } from '@/app-shell/use-app-chrome-layout'
import { useFloatingWorkspacePanel } from '@/app-shell/use-floating-workspace-panel'

import { clearNativeChatComposerDraftsForTests } from '../native-chat/native-chat-composer-draft-store'
import { resetStructuredAgentLaunchRegistryForTests } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'

import type * as LaunchModule from '@/lib/structured-agent-session-launch-create-call'
import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'

const mocks = vi.hoisted(() => ({
  support: vi.fn(),
  subscribe: vi.fn(),
  launch: vi.fn(),
  menu: vi.fn(),
  inventory: vi.fn(),
  loading: false,
  model: null
}))
vi.mock('../native-chat/NativeChatView', () => ({
  default: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="selected-thread">{sessionId}</div>
  )
}))
vi.mock('@/runtime/structured-agent-session-client', async (original) => ({
  ...(await original<object>()),
  subscribeStructuredAgentSessionStatus: mocks.subscribe
}))
vi.mock('@/app-shell/app-window-chrome', async (original) => ({
  ...(await original<object>()),
  shortcutPlatform: 'darwin'
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
vi.mock('@/lib/structured-agent-session-launch-create-call', async (original) => ({
  ...(await original<typeof LaunchModule>()),
  launchStructuredAgentSession: mocks.launch
}))
vi.mock('@/lib/structured-agent-session-host-admission', async (original) => ({
  ...(await original<object>()),
  admitStructuredLaunchOnHost: mocks.support
}))
vi.mock('../tab-bar/use-new-tab-agent-menu-rows', () => ({
  useNewTabAgentMenuRows: (...args: unknown[]) => {
    mocks.menu(...args)
    return mocks.model
  }
}))
vi.mock('../agent/use-agent-launch-picker-inventory', () => ({
  useAgentLaunchPickerInventory: mocks.inventory
}))
const inventory = [
  {
    agent: 'claude',
    label: 'Claude',
    surfaces: ['chat'],
    defaultSurface: 'chat',
    structured: { model: 'opus[1m]', permissionMode: 'ask' },
    terminal: {},
    rows: [],
    catalog: {
      origin: 'probe',
      fetchedAt: 1,
      models: [{ id: 'opus[1m]', label: 'Opus 1M', isDefault: true, efforts: [] }]
    }
  },
  {
    agent: 'codex',
    label: 'Codex',
    surfaces: ['chat'],
    defaultSurface: 'chat',
    structured: { model: 'gpt-5.5', permissionMode: 'ask' },
    terminal: {},
    rows: [],
    catalog: {
      origin: 'probe',
      fetchedAt: 1,
      models: [{ id: 'opus[1m]', label: 'Opus 1M', isDefault: true, efforts: [] }]
    }
  }
] satisfies AgentPickerEntry[]
vi.mock('../native-chat/use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))
const projects = ['A', 'B'].map((id) => ({
  key: `local|${id}`,
  hostId: 'local' as const,
  repo: { id, path: `/${id}`, displayName: id, badgeColor: '', addedAt: 1 },
  worktree: makeWorktree({
    id: `${id}::/${id}`,
    repoId: id,
    path: `/${id}`,
    isMainWorktree: true,
    hostId: 'local'
  })
}))
vi.mock('./thread-projects', async (original) => ({
  ...(await original<object>()),
  eligibleThreadProjects: async () => projects
}))
vi.mock('./use-thread-projects', () => ({
  useThreadProjects: () => ({ projects, loading: mocks.loading })
}))
const NO_GROUPS: TabGroup[] = []
function HostProjection() {
  const groups = useAppStore((s) => s.groupsByWorktree[projects[0].worktree.id] ?? NO_GROUPS)
  const enabled = useAppStore((s) => s.settings?.experimentalThreads === true)
  const visible = useDesktopVisibleGroups(projects[0].worktree.id, groups, enabled)
  return (
    <output data-testid="host-projection">
      {visible.map((group) => group.activeTabId).join(',')}
    </output>
  )
}
function Draft() {
  const page = useDesktopThreadPage()
  const view = useAppStore((s) => s.activeView)
  const selected = page
  return (
    <TooltipProvider>
      {view === 'settings' ? (
        <button onClick={() => useAppStore.getState().closeSettingsPage()}>Settings Back</button>
      ) : selected?.kind === 'new' ? (
        <NewThread key={selected.draftId} {...selected} />
      ) : (
        <div>Opened conversation{page?.kind === 'thread' ? <ThreadSurface /> : null}</div>
      )}
    </TooltipProvider>
  )
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
      }
    }
  })
  clearNativeChatComposerDraftsForTests()
  resetStructuredAgentLaunchRegistryForTests()
  vi.clearAllMocks()
  mocks.subscribe.mockResolvedValue({ unsubscribe: () => {} })
  resetStructuredAgentSessionStatusFeedsForTests()
  mocks.loading = false
  mocks.inventory.mockReturnValue(inventory)
  mocks.support.mockResolvedValue({ kind: 'admitted' })
  setThreadTestPage({
    selection: { kind: 'new', projectKey: projects[0].key, draftId: 'one' }
  })
  useAppStore.setState({
    settings: {
      ...useAppStore.getState().settings!,
      experimentalThreads: true,
      defaultTuiAgent: 'claude'
    },
    activeView: 'thread-draft',
    activeRepoId: 'A',
    activeWorktreeId: projects[0].worktree.id,
    activeWorkspaceExecutionHostId: 'local',
    repos: projects.map((p) => p.repo),
    worktreesByRepo: Object.fromEntries(projects.map((p) => [p.repo.id, [p.worktree]])),
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 1 })),
    refreshGitHubForWorktreeIfStale: vi.fn(),
    revealWorktreeInSidebar: vi.fn(),
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    tabsByWorktree: {},
    tabBarOrderByWorktree: {},
    activeModal: 'none'
  })
  main = await drawTabsFromMain(useAppStore)
})
afterEach(() => {
  cleanup()
  main.close()
  resetStructuredAgentSessionStatusFeedsForTests()
  publishStructuredSessionSummaries(
    [...useStructuredSessionSummaries.getState().threadTabIds].map((tabId) => ({
      tabId,
      summary: null
    }))
  )
})
async function submit() {
  const composer = screen.getByRole('textbox', {
    name: 'Ask for changes, or ask anything about this project'
  })
  act(() => promptEditor(composer).commands.insertContent('Preserve prompt'))
  fireEvent.keyDown(composer, { key: 'Enter' })
  await waitFor(() => expect(mocks.support).toHaveBeenCalled())
  return composer
}
function Entry() {
  useGlobalKeybindings({
    layout: useAppChromeLayout(),
    floatingWorkspace: useFloatingWorkspacePanel()
  })
  return (
    <>
      <TooltipProvider>
        <ThreadsSection />
      </TooltipProvider>
      <Draft />
    </>
  )
}

export { mocks, projects, inventory, Draft, main, submit, HostProjection, Entry }

export function replaceMain(next: TabsDrawnFromMain) {
  main = next
}
