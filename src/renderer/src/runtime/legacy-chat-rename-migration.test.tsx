// @vitest-environment happy-dom
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import * as conversationNames from '../../../shared/agent-session/agent-session-conversation-name'
import * as structuredTabs from '../../../shared/structured-agent-session-tab'
import { brandEphemeralSetupTerminalWorktreeId } from '../../../shared/ephemeral-setup-terminal-worktree-id'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import type * as LayoutRouting from '@/store/terminals/tab-change-through-layout-owner'
import type * as LocalRuntimeCapabilities from './local-runtime-capabilities'
import {
  addWorkspace,
  emptySession
} from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { loadWorkspaceLayoutWithoutReport } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import { renameTab } from '../../../shared/workspace-layout/workspace-layout-tab-commands'
import { saveWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-save'
import { makeWorktree, makeUnifiedTab, TEST_REPO } from '@/store/slices/store-test-helpers'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import { WorkspaceAttachmentOrigins } from '@/components/sidebar/WorkspaceAttachmentOrigins'
import { useAppStore } from '@/store'
import { installLegacyChatRenameMigration } from './legacy-chat-rename-migration'
import { uploadLegacyStructuredChatRename } from './structured-chat-rename'
import { readStructuredChatTabName } from './structured-chat-tab-name'
import { guardPinnedTabClose, resolvePinnedTabLabel } from '@/store/pinned-tab-close-guard'
import {
  subscribeStructuredChatTabNames,
  getStructuredChatTabNames
} from './structured-chat-name-observation'
import { useLiveDashboardSnapshot } from '@/components/dashboard/useLiveDashboardSnapshot'
import { useAgentPaneThreads } from '@/components/activity/use-agent-pane-threads'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from '@/lib/workspace-session-host-hydration'
import { buildPersistedUnifiedTabSessionData } from '@/lib/workspace-session-unified-tabs'
import { persistWorkspaceSessionByHost } from '@/lib/workspace-session-host-persistence'
import { sendMessageToAgent } from '@/lib/agent-message-send'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import { applyWebSessionTabsStorePatch } from './web-session-tabs-sync/store-patch'
import { applyLocalStructuredSessionTabSnapshots } from './local-structured-session-tabs-sync/snapshot-apply'
import { readStructuredAgentLaunchRecord } from '@/lib/agent-session/launch/structured-agent-session-launch-persistence'

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
vi.mock('@/components/native-chat/structured-agent-session-message-sender', () => ({
  sendStructuredAgentSessionMessage: mock.send
}))
vi.mock('@/store', async () => ({
  useAppStore: (await import('@/store/slices/store-test-helpers')).createTestStore()
}))
vi.mock('./runtime-rpc-client', () => ({ callRuntimeRpc: mock.rpc }))
vi.mock('./structured-agent-session-client', () => ({
  supportsStructuredAgentSessionRename: async () => true
}))
vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('@/store/terminals/tab-change-through-layout-owner', () => ({
  sendTabChangeToLayoutOwner: mock.layout
}))
vi.mock('./local-runtime-capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof LocalRuntimeCapabilities>()),
  subscribeLocalRuntimeCapabilitiesKnown: () => () => {}
}))
vi.mock('./runtime-host-contact-regained', () => ({
  subscribeRuntimeHostContactRegained: (_id: string, listener: () => void) => {
    mock.contacts.add(listener)
    return () => mock.contacts.delete(listener)
  }
}))
vi.mock('./structured-agent-session-status-feed', () => ({
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
function loadChat(tab: Tab, owner: ExecutionHostId) {
  const stored = addWorkspace(emptySession(), tab.worktreeId, [
    {
      id: 'group',
      tabs: [{ id: tab.id, entityId: tab.entityId, kind: 'agent-session', entry: tab }]
    }
  ])
  return loadWorkspaceLayoutWithoutReport(owner, stored, nameBasedLoadContext())
}
function seed(tab: Tab) {
  useAppStore.setState({
    workspaceSessionReady: true,
    repos: [{ ...TEST_REPO, id: 'repo' }],
    worktreesByRepo: { repo: [workspace] },
    unifiedTabsByWorktree: { [tab.worktreeId]: [tab] }
  })
}
function partitionedSessionApi(partitions: Record<string, WorkspaceSessionState>) {
  return {
    get: async (host?: string) => partitions[host ?? 'local'] ?? emptySession(),
    set: async (session: WorkspaceSessionState, host?: string) => {
      partitions[host ?? 'local'] = session
    },
    patch: async () => {},
    flush: async () => {}
  }
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

it('keeps invisible aliases without retrying them while valid migration and explicit renames still work', async () => {
  const blank = chat({ executionHostId: 'runtime:paired', customLabel: '\u200B' })
  const joiners = chat({
    id: 'joiners-tab',
    entityId: 'joiners-session',
    executionHostId: 'runtime:paired',
    customLabel: '\u200C\u200D'
  })
  const valid = chat({
    id: 'valid-tab',
    entityId: 'valid-session',
    executionHostId: 'runtime:paired',
    customLabel: '  Visible\u200B name  '
  })
  seed(blank)
  useAppStore.setState({
    unifiedTabsByWorktree: { [workspace.id]: [blank, joiners, valid] },
    groupsByWorktree: saveWorkspaceLayout(loadChat(blank, 'runtime:paired')).tabGroups ?? {}
  })
  let acknowledge = () => {}
  mock.rpc.mockImplementation(
    () =>
      new Promise((resolve) => {
        acknowledge = () => resolve({ applied: true })
      })
  )
  stops.push(installLegacyChatRenameMigration())
  await waitFor(() => expect(mock.rpc).toHaveBeenCalledTimes(1))
  expect(mock.rpc).toHaveBeenLastCalledWith(
    { kind: 'environment', environmentId: 'paired' },
    'agentSession.rename',
    { sessionId: valid.entityId, name: 'Visible name', legacyAlias: true }
  )
  // Contact retries wait for the valid neighbor's in-flight acknowledgment.
  mock.contacts.forEach((regained) => regained())
  await act(async () => acknowledge())
  const current = (index: number) =>
    useAppStore.getState().unifiedTabsByWorktree[workspace.id][index]
  await waitFor(() => expect(current(2).customLabel).toBeNull())
  expect(mock.rpc).toHaveBeenCalledTimes(1)
  expect(
    buildPersistedUnifiedTabSessionData(useAppStore.getState()).unifiedTabs?.[workspace.id]?.map(
      (tab) => tab.customLabel
    )
  ).toEqual(['\u200B', '\u200C\u200D', null])

  useAppStore.getState().setTabCustomTitle(blank.id, 'Visible replacement')
  await waitFor(() => expect(mock.rpc).toHaveBeenCalledTimes(2))
  expect(mock.rpc).toHaveBeenLastCalledWith(expect.anything(), 'agentSession.rename', {
    sessionId: blank.entityId,
    name: 'Visible replacement'
  })
  useAppStore.getState().setTabCustomLabel(blank.id, '\u200D')
  await act(async () => acknowledge())
  expect(current(0).customLabel).toBe('\u200D')
  expect(mock.layout).toHaveBeenCalledTimes(1)

  useAppStore.getState().setTabCustomTitle(blank.id, 'Final visible name')
  await waitFor(() => expect(mock.rpc).toHaveBeenCalledTimes(3))
  acknowledge()
  await waitFor(() => expect(current(0).customLabel).toBeNull())
  const cleanup = mock.layout.mock.calls[1]
  expect(cleanup[2](blank.id)).toEqual({
    type: 'renameTab',
    tabId: blank.id,
    kind: 'custom',
    title: null,
    expected: {
      entityId: blank.entityId,
      executionHostId: 'runtime:paired',
      customTitle: '\u200D'
    }
  })
  expect(current(1).customLabel).toBe(joiners.customLabel)
})

it('bounds reconciliation scans linearly at N and 10N without resending unchanged or in-flight aliases', async () => {
  const normalize = vi.spyOn(conversationNames, 'normalizeAgentSessionConversationName')
  const enumerate = vi.spyOn(structuredTabs, 'isStructuredTab')
  const aliases = ['x'.repeat(5000), '\u200B'.repeat(5000), '\u200C\u200D'.repeat(2500), null]
  for (const count of [40, 400]) {
    const tabs = Array.from({ length: count }, (_, index) =>
      chat({
        id: `scale-tab-${index}`,
        entityId: `scale-session-${index}`,
        executionHostId: 'runtime:paired',
        customLabel: aliases[index % aliases.length]
      })
    )
    seed(tabs[0])
    useAppStore.setState({
      unifiedTabsByWorktree: { [workspace.id]: tabs },
      groupsByWorktree: {
        [workspace.id]: [
          {
            id: 'group',
            worktreeId: workspace.id,
            activeTabId: tabs[0].id,
            tabOrder: tabs.map((tab) => tab.id)
          }
        ]
      }
    })
    mock.rpc.mockReset()
    const acknowledge: (() => void)[] = []
    mock.rpc.mockImplementation(
      () => new Promise((resolve) => acknowledge.push(() => resolve({ applied: true })))
    )
    const expectScan = (population: readonly Tab[]) => {
      expect(enumerate).toHaveBeenCalledTimes(population.length)
      expect(normalize).toHaveBeenCalledTimes(population.length)
      expect(normalize.mock.calls.map(([alias]) => alias)).toEqual(
        population.map((tab) => tab.customLabel ?? '')
      )
      enumerate.mockClear()
      normalize.mockClear()
    }
    enumerate.mockClear()
    normalize.mockClear()
    const stop = installLegacyChatRenameMigration()
    stops.push(stop)
    expectScan(tabs)
    await waitFor(() => expect(mock.rpc).toHaveBeenCalledTimes(count / 4))
    expect(mock.rpc.mock.calls.map(([, , params]) => params)).toEqual(
      tabs
        .filter((_, index) => index % 4 === 0)
        .map((tab) => ({ sessionId: tab.entityId, name: 'x'.repeat(200), legacyAlias: true }))
    )

    // A new snapshot with identical candidates still scans, but must not send again.
    useAppStore.setState({ unifiedTabsByWorktree: { [workspace.id]: [...tabs] } })
    expectScan(tabs)
    // Changing the candidate set reaches the in-flight check rather than the unchanged shortcut.
    useAppStore.setState({ unifiedTabsByWorktree: { [workspace.id]: tabs.slice(1) } })
    expectScan(tabs.slice(1))
    useAppStore.setState({ unifiedTabsByWorktree: { [workspace.id]: [...tabs] } })
    expectScan(tabs)
    await act(async () => {})
    expect(mock.rpc).toHaveBeenCalledTimes(count / 4)
    expect(
      buildPersistedUnifiedTabSessionData(useAppStore.getState()).unifiedTabs?.[workspace.id]?.map(
        (tab) => tab.customLabel
      )
    ).toEqual(tabs.map((tab) => tab.customLabel))

    stop()
    // Refusing cleanup lets outstanding requests settle without unrelated per-alias store writes.
    mock.layout.mockImplementation((_state, _target, _change, _local, answers) => {
      answers?.refused?.()
      return true
    })
    await act(async () => acknowledge.forEach((resolve) => resolve()))
    expect(mock.layout).toHaveBeenCalledTimes(count / 4)
    mock.layout.mockReset()
  }
})

it('migrates an inactive restored alias after reconnect and clears both saved copies only after acknowledgment', async () => {
  const alias = 'x'.repeat(5000)
  const tab = chat({
    worktreeId: 'folder:twin',
    executionHostId: 'runtime:paired',
    customLabel: alias
  })
  let loaded = loadChat(tab, 'runtime:paired')
  mock.layout.mockImplementation((_state, target, change, _local, answers) => {
    if (!target) {
      throw new Error('Missing tab')
    }
    const command = change(target.id)
    if (command.type !== 'renameTab') {
      throw new Error('Unexpected layout command')
    }
    const result = renameTab(loaded.layout, { ...command, workspace: target.worktreeId })
    if (!result.ok) {
      throw new Error('Layout refused cleanup')
    }
    loaded = { ...loaded, layout: result.model }
    answers?.shown?.()
    return true
  })
  seedTwin(tab)
  mock.rpc
    .mockRejectedValueOnce(new Error('Disconnected'))
    .mockResolvedValue({ name: 'x'.repeat(200), applied: true })
  stops.push(installLegacyChatRenameMigration())
  await waitFor(() => expect(mock.rpc).toHaveBeenCalledTimes(1))
  expect(useAppStore.getState().unifiedTabsByWorktree[tab.worktreeId]?.[0]?.customLabel).toBe(alias)
  mock.contacts.forEach((regained) => regained())
  await waitFor(() =>
    expect(
      useAppStore.getState().unifiedTabsByWorktree[tab.worktreeId]?.[0]?.customLabel
    ).toBeNull()
  )
  expect(mock.rpc).toHaveBeenLastCalledWith(expect.anything(), 'agentSession.rename', {
    sessionId: tab.entityId,
    name: 'x'.repeat(200),
    legacyAlias: true
  })
  expect(saveWorkspaceLayout(loaded).unifiedTabs?.[tab.worktreeId]?.[0]?.customLabel).toBeNull()
})

it('retains a replacement alias when main receives an older session cleanup', async () => {
  const tab = chat({ executionHostId: 'local', customLabel: 'Legacy' })
  seed(tab)
  const loaded = loadChat({ ...tab, entityId: 'replacement' }, 'local')
  mock.rpc.mockResolvedValue({ name: 'Legacy', applied: true })
  mock.layout.mockImplementation((_state, target, change, _local, answers) => {
    if (!target) {
      throw new Error('Missing tab')
    }
    const command = change(target.id)
    if (command.type !== 'renameTab') {
      throw new Error('Unexpected command')
    }
    expect(renameTab(loaded.layout, { ...command, workspace: target.worktreeId }).ok).toBe(false)
    answers?.refused?.()
    return true
  })
  expect(
    await uploadLegacyStructuredChatRename(useAppStore.getState, tab, 'Legacy', 'Legacy')
  ).toBe(false)
  expect(saveWorkspaceLayout(loaded).unifiedTabs?.[workspace.id]?.[0]?.customLabel).toBe('Legacy')
  expect(useAppStore.getState().unifiedTabsByWorktree[workspace.id]?.[0]?.customLabel).toBe(
    'Legacy'
  )
})

it('transfers an unstamped alias once its single local owner is known and reloads the canonical name', async () => {
  const tab = chat({ worktreeId: 'folder:unique', customLabel: 'Legacy' })
  seed(tab)
  useAppStore.setState({
    repos: [],
    worktreesByRepo: {},
    restoredRuntimeHostIdByWorkspaceSessionKey: { [tab.worktreeId]: 'runtime:storage-only' }
  })
  mock.snapshot.set(tab.entityId, name(tab, 'History name'))
  mock.rpc.mockResolvedValue({ name: 'History name', applied: false })
  stops.push(installLegacyChatRenameMigration())
  expect(
    await uploadLegacyStructuredChatRename(useAppStore.getState, tab, 'Legacy', 'Legacy')
  ).toBe(false)
  expect(mock.rpc).not.toHaveBeenCalled()
  const groups = saveWorkspaceLayout(loadChat(tab, 'local')).tabGroups?.[tab.worktreeId] ?? []
  useAppStore.setState({ groupsByWorktree: { [tab.worktreeId]: groups } })
  useAppStore.setState({
    folderWorkspaces: [makeFolderWorkspace({ id: 'unique', executionHostId: 'local' })]
  })
  await waitFor(() =>
    expect(useAppStore.getState().unifiedTabsByWorktree[tab.worktreeId][0].customLabel).toBeNull()
  )
  expect(mock.rpc).toHaveBeenCalledExactlyOnceWith({ kind: 'local' }, 'agentSession.rename', {
    sessionId: tab.entityId,
    name: 'Legacy',
    legacyAlias: true
  })
  const saved = {
    ...emptySession(),
    ...buildPersistedUnifiedTabSessionData(useAppStore.getState())
  }
  const api = partitionedSessionApi({ local: emptySession() })
  await persistWorkspaceSessionByHost(api, saved, useAppStore.getState())
  const read = await fetchWorkspaceSessionWithRuntimeHostOwners(api, [])
  useAppStore.getState().hydrateWorkspaceSession(read.session, read)
  useAppStore.getState().hydrateTabsSession(read.session)
  useAppStore.setState({ activeWorktreeId: 'elsewhere' })
  const restored = useAppStore.getState().unifiedTabsByWorktree[tab.worktreeId][0]
  expect(restored.executionHostId).toBeUndefined()
  expect(restored.customLabel).toBeNull()
  expect(readStructuredChatTabName(restored, useAppStore.getState())).toBe('History name')
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
    agentStatusByPaneKey: {
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
    }
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

it('names a native pinned-close confirmation from the owning host after alias retirement', () => {
  const tab = chat({ executionHostId: 'runtime:paired', isPinned: true, customLabel: null })
  seed(tab)
  const requestPinnedTabCloseConfirm = vi.fn()
  useAppStore.setState({
    settings: createGlobalSettingsFixture({ confirmClosePinnedTab: true }),
    requestPinnedTabCloseConfirm
  })
  mock.snapshot = new Map([[tab.entityId, name(tab, 'Other host name')]])
  mock.paired = new Map([[tab.entityId, name(tab, 'Saved native name')]])
  const onClose = vi.fn()
  guardPinnedTabClose({
    isPinned: tab.isPinned === true,
    tabLabel: resolvePinnedTabLabel(useAppStore.getState(), tab.worktreeId, tab.id),
    onClose
  })
  expect(requestPinnedTabCloseConfirm).toHaveBeenCalledWith({
    tabLabel: 'Saved native name',
    onConfirm: onClose
  })
})

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

it('updates an unstamped setup chat name when settings replace its fallback owner', () => {
  const tab = chat({ worktreeId: brandEphemeralSetupTerminalWorktreeId('rename-observer') })
  seed(tab)
  const settings = createGlobalSettingsFixture({ activeRuntimeEnvironmentId: null })
  useAppStore.setState({
    settings,
    runtimeEnvironments: [
      {
        id: 'paired',
        name: 'paired',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: null,
        endpoints: [{ id: 'ws-paired', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://x' }],
        preferredEndpointId: 'ws-paired'
      }
    ]
  })
  mock.snapshot.set(tab.entityId, name(tab, 'Local name'))
  mock.paired.set(tab.entityId, name(tab, 'Paired name'))
  expect(getStructuredChatTabNames().get(tab)).toMatchObject({
    owner: 'local',
    savedName: 'Local name'
  })
  const changed = vi.fn()
  stops.push(subscribeStructuredChatTabNames(changed))

  useAppStore.setState({ settings: { ...settings, activeRuntimeEnvironmentId: 'paired' } })

  expect(changed).toHaveBeenCalledTimes(1)
  expect(getStructuredChatTabNames().get(tab)).toMatchObject({
    owner: 'runtime:paired',
    savedName: 'Paired name'
  })
  expect(settings.activeRuntimeEnvironmentId).toBeNull()
  expect(mock.rpc).not.toHaveBeenCalled()
})

it('traces legacy runtime storage movement, action routing and switch-away before inventory', async () => {
  const tab = chat({ worktreeId: 'folder:twin', customLabel: 'Legacy paired' })
  seedTwin(tab)
  useAppStore.setState({ workspaceSessionReady: false })
  const local = {
    ...emptySession(),
    activeWorktreeId: tab.worktreeId,
    activeWorkspaceKey: 'folder:twin' as const,
    activeWorkspaceExecutionHostId: 'runtime:b' as const
  }
  const partitions: Record<string, WorkspaceSessionState> = {
    local,
    'runtime:b': {
      ...emptySession(),
      unifiedTabs: { [tab.worktreeId]: [tab] },
      tabGroups: {
        [tab.worktreeId]: [
          { id: tab.groupId, worktreeId: tab.worktreeId, activeTabId: tab.id, tabOrder: [tab.id] }
        ]
      }
    }
  }
  const api = partitionedSessionApi(partitions)
  const restored = await fetchWorkspaceSessionWithRuntimeHostOwners(
    api,
    [],
    ['runtime:a', 'runtime:b']
  )
  useAppStore.getState().hydrateWorkspaceSession(restored.session, restored)
  useAppStore.getState().hydrateTabsSession(restored.session)
  expect(useAppStore.getState().restoredRuntimeHostIdByWorkspaceSessionKey[tab.worktreeId]).toBe(
    'runtime:b'
  )
  const current = () => useAppStore.getState().unifiedTabsByWorktree[tab.worktreeId][0]
  expect(current().executionHostId).toBeUndefined()
  const folder = makeFolderWorkspace({ id: 'twin' })
  useAppStore.setState({
    activeWorkspaceExecutionHostId: 'runtime:b',
    folderWorkspaces: [
      { ...folder, executionHostId: 'runtime:a' },
      { ...folder, executionHostId: 'runtime:b' }
    ]
  })
  const payload = {
    ...restored.session,
    ...buildPersistedUnifiedTabSessionData(useAppStore.getState())
  }
  expect(payload.unifiedTabs?.[tab.worktreeId]?.[0]).toBe(current())
  await persistWorkspaceSessionByHost(api, payload, useAppStore.getState())
  expect(partitions['runtime:a'].unifiedTabs?.[tab.worktreeId]?.[0]).toBe(current())
  const reloaded = await fetchWorkspaceSessionWithRuntimeHostOwners(
    api,
    [],
    ['runtime:a', 'runtime:b']
  )
  expect(reloaded.contestedPrimaryHostBySessionKey[tab.worktreeId]).toBe('runtime:a')
  useAppStore.getState().hydrateWorkspaceSession(reloaded.session, reloaded)
  useAppStore.getState().hydrateTabsSession(reloaded.session)
  expect(current().executionHostId).toBeUndefined()
  useAppStore.setState({
    activeWorktreeId: tab.worktreeId,
    activeWorkspaceExecutionHostId: 'runtime:a'
  })
  mock.send.mockReturnValue({ outcome: Promise.resolve('recorded') })
  expect(
    await sendMessageToAgent({
      worktreeId: tab.worktreeId,
      target: { kind: 'structured-session', sessionId: tab.entityId },
      prompt: 'hello'
    })
  ).toEqual({ status: 'sent' })
  expect(mock.send).toHaveBeenCalledWith(
    expect.objectContaining({ target: { kind: 'environment', environmentId: 'a' } })
  )
  mock.paired = new Map([[tab.entityId, name(tab, 'Legacy paired')]])
  mock.rpc.mockResolvedValue({ name: 'Legacy paired', applied: true })
  await useAppStore.getState().reconnectPersistedTerminals()
  expect(useAppStore.getState().workspaceSessionReady).toBe(true)
  stops.push(installLegacyChatRenameMigration())
  expect(
    await uploadLegacyStructuredChatRename(
      useAppStore.getState,
      current(),
      'Legacy paired',
      'Legacy paired'
    )
  ).toBe(false)
  expect(mock.rpc).not.toHaveBeenCalled()
  expect(current().customLabel).toBe('Legacy paired')
  expect(readStructuredChatTabName(current(), useAppStore.getState())).toBe('Legacy paired')
  useAppStore.setState({ activeWorktreeId: 'elsewhere' })
  expect(mock.rpc).not.toHaveBeenCalled()
  expect(readStructuredChatTabName(current(), useAppStore.getState())).toBe('Legacy paired')
  useAppStore.setState({
    activeWorktreeId: tab.worktreeId,
    activeWorkspaceExecutionHostId: 'runtime:b'
  })
  expect(mock.rpc).not.toHaveBeenCalled()
  mock.paired.set(tab.entityId, name(tab, 'Explicit name'))
  useAppStore.getState().setTabCustomTitle(current().id, '  Explicit name  ')
  // Navigation happens before the dynamic rename import resumes, with inventory still absent.
  useAppStore.setState({
    activeWorktreeId: 'elsewhere',
    activeWorkspaceExecutionHostId: 'runtime:a'
  })
  await waitFor(() => expect(current().customLabel).toBe('Explicit name'))
  expect(mock.rpc).toHaveBeenCalledExactlyOnceWith(
    { kind: 'environment', environmentId: 'b' },
    'agentSession.rename',
    {
      sessionId: tab.entityId,
      name: 'Explicit name'
    }
  )
  expect(current().executionHostId).toBeUndefined()
  expect(readStructuredChatTabName(current(), useAppStore.getState())).toBe('Explicit name')
  await persistWorkspaceSessionByHost(
    api,
    { ...reloaded.session, ...buildPersistedUnifiedTabSessionData(useAppStore.getState()) },
    useAppStore.getState()
  )
  const renamed = await fetchWorkspaceSessionWithRuntimeHostOwners(
    api,
    [],
    ['runtime:a', 'runtime:b']
  )
  useAppStore.getState().hydrateWorkspaceSession(renamed.session, renamed)
  useAppStore.getState().hydrateTabsSession(renamed.session)
  useAppStore.setState({ activeWorktreeId: 'elsewhere' })
  expect(current().executionHostId).toBeUndefined()
  expect(readStructuredChatTabName(current(), useAppStore.getState())).toBe('Explicit name')
  expect(mock.rpc).toHaveBeenCalledTimes(1)
  // The existing migration retires the copy once catalog ownership is proved.
  useAppStore.setState({ folderWorkspaces: [{ ...folder, executionHostId: 'runtime:b' }] })
  await waitFor(() => expect(current().customLabel).toBeNull())
  expect(mock.rpc).toHaveBeenLastCalledWith(
    { kind: 'environment', environmentId: 'b' },
    'agentSession.rename',
    { sessionId: tab.entityId, name: 'Explicit name', legacyAlias: true }
  )
  expect(readStructuredChatTabName(current(), useAppStore.getState())).toBe('Explicit name')
})

it('traces a local legacy alias through foreign same-ID inventory and authoritative omission', () => {
  const tab = chat({ customLabel: 'Legacy local' })
  seed(tab)
  expect(readStructuredAgentLaunchRecord(tab.entityId)).toBeUndefined()
  const snapshot: RuntimeMobileSessionTabsResult = {
    worktree: tab.worktreeId,
    publicationEpoch: 'identity-evidence',
    snapshotVersion: 1,
    activeTabId: tab.id,
    activeTabType: 'agent-session',
    activeGroupId: tab.groupId,
    tabs: [
      {
        type: 'agent-session',
        id: tab.id,
        sessionId: tab.entityId,
        agent: 'codex',
        title: 'Codex Chat',
        isActive: true
      }
    ]
  }
  const current = () => useAppStore.getState().unifiedTabsByWorktree[tab.worktreeId][0]
  applyWebSessionTabsStorePatch(
    (state) => applyLocalStructuredSessionTabSnapshots(state, [snapshot]),
    { frames: [] }
  )()
  expect(current()).toMatchObject({
    id: tab.id,
    customLabel: 'Legacy local',
    executionHostId: 'local',
    createdAt: tab.createdAt
  })
  const localOccurrence = current()
  applyWebSessionTabsStorePatch((state) => applyWebSessionTabsSnapshot(state, snapshot, 'a'), {
    frames: []
  })()
  expect(current()).not.toBe(localOccurrence)
  expect(current()).toMatchObject({
    id: tab.id,
    customLabel: 'Legacy local',
    executionHostId: 'runtime:a',
    createdAt: tab.createdAt
  })
  applyWebSessionTabsStorePatch(
    (state) =>
      applyWebSessionTabsSnapshot(state, { ...snapshot, snapshotVersion: 2, tabs: [] }, 'a'),
    { frames: [] }
  )()
  expect(useAppStore.getState().unifiedTabsByWorktree[tab.worktreeId] ?? []).toEqual([])
})
