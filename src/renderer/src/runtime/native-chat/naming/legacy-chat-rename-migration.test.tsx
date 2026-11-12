import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
// @vitest-environment happy-dom
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../../shared/tab-types'
import '../../../../../shared/global-settings-test-fixture'

import '../../../../../shared/ephemeral-setup-terminal-worktree-id'
import type { AgentSessionStatusSummary } from '../../../../../shared/agent-session/agent-session-wire'
import type * as LayoutRouting from '@/store/terminals/tab-change-through-layout-owner'
import type * as LocalRuntimeCapabilities from '../../hosts/capabilities/local-runtime-capabilities'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { WorkspaceAttachmentOrigins } from '@/components/sidebar/workspace-card/review/WorkspaceAttachmentOrigins'
import { useAppStore } from '@/store/index'
import { readStructuredChatTabName } from './structured-chat-tab-name'
import '@/store/slices/tabs/closing/pinned-tab-close-guard'
import {
  subscribeStructuredChatTabNames,
  getStructuredChatTabNames
} from './structured-chat-name-observation'
import { useLiveDashboardSnapshot } from '@/components/dashboard/useLiveDashboardSnapshot'
import { useAgentPaneThreads } from '@/components/activity/use-agent-pane-threads'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'

import '../../web-session-tabs-sync/snapshot-api'
import '../../web-session-tabs-sync/store-patch'
import '../../local-structured-session-tabs-sync/snapshot-apply'
import '@/lib/agent-session/launch/structured-agent-session-launch-persistence'

const mock = vi.hoisted(() => ({
  rpc: vi.fn(),
  layout: vi.fn<typeof LayoutRouting.sendTabChangeToLayoutOwner>(),
  contacts: new Set<() => void>(),
  listeners: new Set<() => void>(),
  snapshot: new Map<string, AgentSessionStatusSummary>(),
  paired: new Map<string, AgentSessionStatusSummary>(),
  activates: vi.fn(),
  deactivates: vi.fn(),
  send: vi.fn()
}))
vi.mock(
  '@/components/native-chat/session/structured/delivery/structured-agent-session-message-sender',
  () => ({
    sendStructuredAgentSessionMessage: mock.send
  })
)
vi.mock('@/store/index', async () => ({
  useAppStore: (await import('@/store/testing/app-store-test-fixture')).createTestStore()
}))
vi.mock('../../rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: mock.rpc
}))
vi.mock('../host-capabilities/structured-agent-session-host-support', () => ({
  supportsStructuredAgentSessionRename: async () => true
}))
vi.mock('../../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('@/store/terminals/tab-change-through-layout-owner', () => ({
  sendTabChangeToLayoutOwner: mock.layout
}))
vi.mock('../../hosts/capabilities/local-runtime-capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof LocalRuntimeCapabilities>()),
  subscribeLocalRuntimeCapabilitiesKnown: () => () => {}
}))
vi.mock('../../hosts/connections/runtime-host-contact-regained', () => ({
  subscribeRuntimeHostContactRegained: (_id: string, listener: () => void) => {
    mock.contacts.add(listener)
    return () => mock.contacts.delete(listener)
  }
}))
vi.mock('../status/structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: (target: RuntimeClientTarget) => ({
    getSnapshot: () => (target.kind === 'local' ? mock.snapshot : mock.paired),
    getNamingSnapshot: () => (target.kind === 'local' ? mock.snapshot : mock.paired),
    activate: () => {
      mock.activates()
      return mock.deactivates
    },
    subscribe: (listener: () => void) => {
      mock.listeners.add(listener)
      return () => mock.listeners.delete(listener)
    }
  })
}))

const workspace = makeWorktree({ id: 'repo::/tmp/rename-migration', repoId: 'repo' })
const chat = (extra: Partial<Tab> = {}): Tab =>
  makeUnifiedTab({
    id: 'chat-tab',
    entityId: 'session-1',
    worktreeId: workspace.id,
    groupId: 'group',
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    label: 'Codex Chat',
    ...extra
  })
function seed(tab: Tab) {
  useAppStore.setState({
    workspaceSessionReady: true,
    repos: [{ ...TEST_REPO, id: 'repo' }],
    worktreesByRepo: { repo: [workspace] },
    unifiedTabsByWorktree: { [tab.worktreeId]: [tab] }
  })
}
const stops: (() => void)[] = []
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  useAppStore.setState(useAppStore.getInitialState(), true)
  mock.activates.mockClear()
  mock.deactivates.mockClear()
  mock.rpc.mockReset()
  mock.layout.mockReset()
  mock.layout.mockReturnValue(false)
})
afterEach(() => {
  cleanup()
  stops.splice(0).forEach((stop) => stop())
  mock.snapshot.clear()
  mock.paired.clear()
  vi.restoreAllMocks()
})

function seedTwin(tab: Tab) {
  seed(tab)
  const folder = makeFolderWorkspace({ id: 'twin' })
  const paneKey = makePaneKey(tab.id, '11111111-1111-4111-8111-111111111111')
  useAppStore.setState({
    activeWorktreeId: tab.worktreeId,
    activeWorkspaceExecutionHostId: 'runtime:paired',
    folderWorkspaces: [
      { ...folder, executionHostId: 'local' },
      { ...folder, executionHostId: 'runtime:paired' }
    ],
    agentStatusByPaneKey: acceptedAgentStatuses(
      Object.entries({
        [paneKey]: {
          paneKey,
          tabId: tab.id,
          worktreeId: tab.worktreeId,
          agentType: 'codex',
          state: 'working',
          prompt: '',
          updatedAt: Date.now(),
          stateStartedAt: Date.now(),
          stateHistory: []
        }
      })
    )
  })
}
function name(tab: Tab, conversationName: string): AgentSessionStatusSummary {
  return {
    sessionId: tab.entityId,
    workspaceId: tab.worktreeId,
    agent: 'codex',
    status: null,
    latestPrompt: '',
    updatedAt: 1,
    conversationName
  }
}

it('shares qualified current names with live dashboard and attachments without activating plain reads', () => {
  const tab = chat({ worktreeId: 'folder:twin' })
  seedTwin(tab)
  mock.snapshot = new Map([[tab.entityId, name(tab, 'Same')]])
  mock.paired = new Map([[tab.entityId, name(tab, 'Same')]])
  const attached = chat({ id: 'attached-tab', executionHostId: 'runtime:paired' })
  useAppStore.setState((state) => ({
    unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree, [workspace.id]: [attached] }
  }))
  const before = getStructuredChatTabNames()
  expect(getStructuredChatTabNames()).toBe(before)
  expect(before.get(tab)).toMatchObject({ owner: 'runtime:paired', savedName: 'Same' })
  expect(mock.activates).not.toHaveBeenCalled()
  stops.push(useAppStore.subscribe(() => getStructuredChatTabNames()))
  const changed = vi.fn()
  const stop = subscribeStructuredChatTabNames(changed)
  const view = render(
    <WorkspaceAttachmentOrigins
      workspace={{ ...workspace, hostId: 'runtime:paired' }}
      item={{
        provider: 'github',
        type: 'issue',
        number: 1,
        origins: [{ kind: 'observed', tabId: attached.id, hostId: 'runtime:paired' }]
      }}
    />
  )
  const dashboard = renderHook(useLiveDashboardSnapshot)
  const activity = renderHook(() =>
    useAgentPaneThreads({
      query: '',
      readFilter: 'all',
      groupBy: 'none',
      selectedPaneKey: null
    })
  )
  const activityTitle = () =>
    activity.result.current.allThreads.find((row) => row.tab.id === tab.id)?.paneTitle
  const shown = () =>
    dashboard.result.current.cards.find((card) => card.tabId === tab.id)?.conversationName
  expect(shown()).toBe('Same')
  expect(activityTitle()).toBe('Same')
  expect(view.container.textContent).toContain('Same')
  expect(mock.activates).toHaveBeenCalledTimes(1)
  act(() => useAppStore.setState({ agentStatusEpoch: 1 }))
  expect(getStructuredChatTabNames()).toBe(before)
  act(() => useAppStore.setState({ activeWorkspaceExecutionHostId: 'local' }))
  expect(getStructuredChatTabNames()).not.toBe(before)
  expect(getStructuredChatTabNames().get(tab)?.owner).toBe('local')
  expect(activityTitle()).toBe('Same')
  act(() => {
    mock.snapshot = new Map([[tab.entityId, name(tab, 'Local renamed')]])
    mock.listeners.forEach((notify) => notify())
  })
  expect(shown()).toBe('Local renamed')
  expect(activityTitle()).toBe('Local renamed')
  const local = getStructuredChatTabNames()
  act(() => {
    mock.paired = new Map([[tab.entityId, name(tab, 'Unrelated')]])
    mock.listeners.forEach((notify) => notify())
  })
  expect(getStructuredChatTabNames().get(tab)).toEqual(local.get(tab))
  expect(view.container.textContent).toContain('Unrelated')
  expect(shown()).toBe('Local renamed')
  expect(activityTitle()).toBe('Local renamed')
  act(() => useAppStore.setState({ activeWorktreeId: 'elsewhere' }))
  expect(getStructuredChatTabNames().get(tab)?.owner).toBeNull()
  expect(shown()).toBe('Codex Chat')
  expect(activityTitle()).toBe('Codex Chat')
  const replacement = { ...tab }
  act(() => useAppStore.setState({ unifiedTabsByWorktree: { [tab.worktreeId]: [replacement] } }))
  expect(getStructuredChatTabNames().has(tab)).toBe(false)
  expect(getStructuredChatTabNames().has(replacement)).toBe(true)
  dashboard.unmount()
  activity.unmount()
  view.unmount()
  expect(mock.deactivates).toHaveBeenCalledTimes(2)
  stop()
  mock.paired = new Map([[tab.entityId, name(tab, 'Dormant rename')]])
  useAppStore.setState({
    activeWorktreeId: tab.worktreeId,
    activeWorkspaceExecutionHostId: 'runtime:paired'
  })
  expect(getStructuredChatTabNames().get(replacement)?.savedName).toBe('Dormant rename')
  expect(readStructuredChatTabName(replacement, useAppStore.getState())).toBe('Dormant rename')
  expect(mock.activates).toHaveBeenCalledTimes(2)
})
