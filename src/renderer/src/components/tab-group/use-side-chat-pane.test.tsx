// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  addWorkspace,
  emptySession,
  FOLDER_KEY,
  GIT_KEY
} from '../../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { bootWindowFromPartitions } from '../../app-shell/startup-window-view.test-fixture'
import { createStoreSessionMockApi } from '../../store/slices/store-session-test-harness'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { loadMainLayoutModel } from '@/runtime/main-loaded-layout-frames.test-fixture'
import { endLayoutFramePositions } from '@/runtime/layout-frame-position'
import { openWorkspaceLayoutFrameSync } from '@/runtime/workspace-layout-frame-sync'
import { openStructuredAgentSessionProvisionalTab } from '@/lib/agent-session/launch/structured-agent-session-launch-surface'
import {
  readStructuredAgentLaunchRecord,
  writeStructuredAgentLaunchRecord,
  deleteStructuredAgentLaunchRecord,
  resetStructuredAgentLaunchPersistenceForTests
} from '@/lib/agent-session/launch/structured-agent-session-launch-persistence'
import { notifyStructuredLaunchListeners } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { useSideChatPane } from './use-side-chat-pane'
import { sideChatPanePlacement } from './side-chat-pane-placement'
import { openNativeChatSideChat } from '@/lib/open-native-chat-side-chat'
import type * as LaunchPlan from '@/lib/agent-session-launch-plan'

vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return launches.layoutOwnerIsMain
  }
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
vi.mock('@/runtime/workspace-layout-frame-sync', async (original) => ({
  ...(await original<object>()),
  showStartupLayoutFrames: () => {}
}))
vi.mock('./tab-group-panel-split-target', () => ({
  getTabGroupPanelRect: () => ({ width: 500, height: 900 })
}))
vi.mock('@/runtime/structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: () => feed
}))
const feed = vi.hoisted(() => ({
  activate: () => () => {},
  subscribe: () => () => {},
  getSnapshot: () =>
    new Map([
      ['codex_one', { sideChatOf: 'codex_parent' }],
      ['codex_two', { sideChatOf: 'codex_one' }],
      ['codex_three', { sideChatOf: 'codex_parent' }]
    ])
}))
const launches = vi.hoisted(() => ({ count: 0, fail: false, layoutOwnerIsMain: true }))
vi.mock('@/runtime/structured-agent-session-client', async (original) => ({
  ...(await original<object>()),
  supportsStructuredAgentSessionSideChat: async () => true
}))
vi.mock('@/lib/structured-agent-session-host-admission', async (original) => ({
  ...(await original<object>()),
  admitStructuredLaunchOnHost: async () => ({ kind: 'admitted' })
}))
vi.mock('@/lib/agent-session-launch-plan', async (original) => {
  const actual = await original<typeof LaunchPlan>()
  return {
    ...actual,
    adoptAgentSessionLaunchVerdict: (verdict: LaunchPlan.AgentSessionLaunchVerdict) => ({
      ...actual.adoptAgentSessionLaunchVerdict(verdict),
      begin: (_hooks: unknown, target?: LaunchPlan.AgentSessionLaunchTarget) => {
        if (launches.fail) {
          return null
        }
        const sessionId = `codex_new_${++launches.count}`
        writeStructuredAgentLaunchRecord({
          sessionId,
          agent: 'codex',
          executionHostId: 'local',
          lifecycle: 'pending',
          clientOperationId: sessionId,
          payloadFingerprint: 'a'.repeat(64),
          expectedRuntimeFence: null,
          sideChatOf: verdict.sideChatOf,
          surfaceAddress: target?.surfaceAddress
        })
        return {
          sessionId,
          executionHostId: 'local',
          cancel: () => {},
          settlement: Promise.resolve({ kind: 'structured', sessionId, fence: 0 })
        }
      }
    })
  }
})
createStoreSessionMockApi()
let close = () => {}
const settle = () => layoutApplyTestTransport.settle()
const workspaceTabs = () => useAppStore.getState().unifiedTabsByWorktree[FOLDER_KEY] ?? []
const groupOf = (sessionId: string) =>
  workspaceTabs().find((tab) => tab.entityId === sessionId)?.groupId

beforeEach(async () => {
  launches.count = 0
  launches.fail = false
  launches.layoutOwnerIsMain = true
  resetStructuredAgentLaunchPersistenceForTests()
  layoutApplyTestTransport.reset()
  const session = addWorkspace(
    addWorkspace(emptySession(), FOLDER_KEY, [
      {
        id: 'source',
        activeTabId: 'parent',
        tabs: [
          {
            id: 'parent',
            kind: 'agent-session',
            entityId: 'codex_parent',
            entry: { agentSessionAgent: 'codex', label: 'Main' }
          },
          {
            id: 'one',
            kind: 'agent-session',
            entityId: 'codex_one',
            entry: { agentSessionAgent: 'codex', label: 'One' }
          }
        ]
      },
      {
        id: 'another-source',
        activeTabId: 'another-parent',
        tabs: [
          {
            id: 'another-parent',
            kind: 'agent-session',
            entityId: 'codex_another',
            entry: { agentSessionAgent: 'codex' }
          },
          {
            id: 'two',
            kind: 'agent-session',
            entityId: 'codex_two',
            entry: { agentSessionAgent: 'codex', label: 'Two' }
          }
        ]
      }
    ]),
    GIT_KEY,
    [
      {
        id: 'other',
        tabs: [
          {
            id: 'other-tab',
            kind: 'agent-session',
            entityId: 'other_session',
            entry: { agentSessionAgent: 'codex' }
          }
        ]
      }
    ]
  )
  layoutApplyTestTransport.useMainModel(loadMainLayoutModel('local', session))
  layoutApplyTestTransport.answerWith('apply')
  await bootWindowFromPartitions(useAppStore, [{ hostId: 'local', session }])
  const sync = openWorkspaceLayoutFrameSync(useAppStore)
  sync.start()
  await settle()
  close = () => sync.close()
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), nativeChatSideChatPane: false }
  })
})
afterEach(() => {
  cleanup()
  close()
  endLayoutFramePositions()
})

it('collects existing and future forks through main-owned frames, then leaves new forks at their source when disabled', async () => {
  renderHook(() => useSideChatPane(FOLDER_KEY, true))
  const other = useAppStore.getState().groupsByWorktree[GIT_KEY]
  expect(groupOf('codex_one')).toBe(groupOf('codex_parent'))
  act(() =>
    useAppStore.setState((state) => ({
      settings: { ...state.settings!, nativeChatSideChatPane: true }
    }))
  )
  await act(settle)
  await vi.waitFor(() => expect(groupOf('codex_two')).not.toBe(groupOf('codex_parent')))
  expect(groupOf('codex_two')).toBe(groupOf('codex_one'))
  expect(useAppStore.getState().groupsByWorktree[FOLDER_KEY]).toHaveLength(3)
  expect(useAppStore.getState().activeGroupIdByWorktree[FOLDER_KEY]).toBe(groupOf('codex_parent'))
  expect(useAppStore.getState().groupsByWorktree[GIT_KEY]).toEqual(other)
  expect(layoutApplyTestTransport.sentOfType('splitGroup')).toMatchObject([{ direction: 'down' }])
  act(() =>
    useAppStore.setState((state) => ({
      settings: { ...state.settings!, nativeChatSideChatPane: false }
    }))
  )
  act(() => {
    openStructuredAgentSessionProvisionalTab({
      worktreeId: FOLDER_KEY,
      executionHostId: 'local',
      sessionId: 'codex_three',
      agent: 'codex',
      afterTabId: 'parent'
    })
  })
  await act(settle)
  expect(groupOf('codex_three')).toBe(groupOf('codex_parent'))
  expect(useAppStore.getState().groupsByWorktree[FOLDER_KEY]).toHaveLength(3)
  act(() =>
    useAppStore.setState((state) => ({
      settings: { ...state.settings!, nativeChatSideChatPane: true }
    }))
  )
  await act(settle)
  await vi.waitFor(() => expect(groupOf('codex_three')).toBe(groupOf('codex_one')))
  expect(layoutApplyTestTransport.sentOfType('splitGroup')).toHaveLength(1)
})

it('keeps an unconfirmed fork at its create address until publication, then groups it', async () => {
  for (const sessionId of ['codex_one', 'codex_two']) {
    writeStructuredAgentLaunchRecord({
      sessionId,
      agent: 'codex',
      executionHostId: 'local',
      lifecycle: 'pending',
      clientOperationId: `create-${sessionId}`,
      payloadFingerprint: 'a'.repeat(64),
      expectedRuntimeFence: null,
      sideChatOf: 'codex_parent',
      surfaceAddress: { worktreeId: FOLDER_KEY, precedingTabIds: ['parent'] }
    })
  }
  useAppStore.setState((state) => ({
    settings: { ...state.settings!, nativeChatSideChatPane: true }
  }))
  renderHook(() => useSideChatPane(FOLDER_KEY, true))
  await act(settle)
  expect(layoutApplyTestTransport.sentOfType('splitGroup')).toHaveLength(0)
  expect(groupOf('codex_one')).toBe(groupOf('codex_parent'))
  act(() => {
    for (const id of ['codex_one', 'codex_two']) {
      deleteStructuredAgentLaunchRecord(id)
    }
    notifyStructuredLaunchListeners()
  })
  await act(settle)
  await vi.waitFor(() => expect(groupOf('codex_one')).not.toBe(groupOf('codex_parent')))
  expect(groupOf('codex_two')).toBe(groupOf('codex_one'))
  expect(layoutApplyTestTransport.sentOfType('splitGroup')).toHaveLength(1)
})

it.each([true, false])(
  'opens forks directly in the pane at the left before publication (main owner: %s)',
  async (mainOwner) => {
    launches.layoutOwnerIsMain = mainOwner
    useAppStore.setState((state) => ({
      settings: { ...state.settings!, nativeChatSideChatPane: true }
    }))
    const sourceGroup = useAppStore.getState().getTab('other-tab')!.groupId
    const observedGroups: string[] = []
    const stop = useAppStore.subscribe((state) => {
      const tab = state.unifiedTabsByWorktree[GIT_KEY]?.find(
        (tab) => tab.entityId === 'codex_new_1'
      )
      if (tab) {
        observedGroups.push(tab.groupId)
      }
    })
    try {
      const source = { tabId: 'other-tab', worktreeId: GIT_KEY, sessionId: 'other_session' }
      await expect(openNativeChatSideChat(source)).resolves.toBe(true)
      await act(settle)
      const first = useAppStore
        .getState()
        .unifiedTabsByWorktree[GIT_KEY]!.find((tab) => tab.entityId === 'codex_new_1')!
      expect(observedGroups.length).toBeGreaterThan(0)
      expect(observedGroups).not.toContain(sourceGroup)
      expect(first.groupId).not.toBe(sourceGroup)
      expect(readStructuredAgentLaunchRecord(first.entityId)?.surfaceAddress).toEqual({
        worktreeId: GIT_KEY,
        targetGroupId: first.groupId,
        precedingTabIds: []
      })
      await expect(
        openNativeChatSideChat({
          tabId: first.id,
          worktreeId: GIT_KEY,
          sessionId: first.entityId
        })
      ).resolves.toBe(true)
      await act(settle)
      const second = useAppStore
        .getState()
        .unifiedTabsByWorktree[GIT_KEY]!.find((tab) => tab.entityId === 'codex_new_2')!
      expect(second.groupId).toBe(first.groupId)
      expect(
        useAppStore
          .getState()
          .groupsByWorktree[GIT_KEY]!.find((group) => group.id === first.groupId)!.tabOrder
      ).toEqual([second.id, first.id])
      expect(layoutApplyTestTransport.sentOfType('splitGroup')).toHaveLength(0)
      expect(layoutApplyTestTransport.sentOfType('openAgentSessionTab')).toMatchObject(
        mainOwner
          ? [
              { split: { besideGroupId: sourceGroup, direction: 'down' } },
              { groupId: first.groupId, index: 0 }
            ]
          : []
      )
    } finally {
      stop()
    }
  }
)

it('reuses a pending pane while two independent opens await layout frames', async () => {
  useAppStore.setState((state) => ({
    settings: { ...state.settings!, nativeChatSideChatPane: true }
  }))
  layoutApplyTestTransport.answerWith('pending')
  const source = { tabId: 'other-tab', worktreeId: GIT_KEY, sessionId: 'other_session' }
  await expect(
    Promise.all([openNativeChatSideChat(source, 'one'), openNativeChatSideChat(source, 'two')])
  ).resolves.toEqual([true, true])
  const opens = layoutApplyTestTransport.sentOfType('openAgentSessionTab')
  expect(opens).toHaveLength(2)
  expect(opens[0]!.groupId).toBe(opens[1]!.groupId)
  expect(useAppStore.getState().groupsByWorktree[GIT_KEY]).toHaveLength(2)
  expect(useAppStore.getState().unifiedTabsByWorktree[GIT_KEY]).toHaveLength(1)
  layoutApplyTestTransport.answerWith('apply')
  layoutApplyTestTransport.answerPending()
  await act(settle)
  expect(
    useAppStore
      .getState()
      .groupsByWorktree[GIT_KEY]!.find((group) => group.id === opens[0]!.groupId)!.tabOrder
  ).toEqual([opens[1]!.tabId, opens[0]!.tabId])
})

it('removes an unused prepared split when the launch cannot start, and preserves source placement when off', async () => {
  useAppStore.setState((state) => ({
    settings: { ...state.settings!, nativeChatSideChatPane: true }
  }))
  launches.fail = true
  const source = { tabId: 'other-tab', worktreeId: GIT_KEY, sessionId: 'other_session' }
  await expect(openNativeChatSideChat(source)).resolves.toBe(false)
  expect(useAppStore.getState().groupsByWorktree[GIT_KEY]).toHaveLength(1)
  launches.fail = false
  useAppStore.setState((state) => ({
    settings: { ...state.settings!, nativeChatSideChatPane: false }
  }))
  await expect(openNativeChatSideChat(source)).resolves.toBe(true)
  await act(settle)
  expect(useAppStore.getState().groupsByWorktree[GIT_KEY]!.map((group) => group.tabOrder)).toEqual([
    ['other-tab', 'structured-agent-session-codex_new_1']
  ])
})

it('waits for an existing pending side-chat pane instead of splitting another one', () => {
  const state = useAppStore.getState()
  const tab = state.getTab('other-tab')!
  const group = state.groupsByWorktree[GIT_KEY]![0]!
  const tabs = [
    { ...tab, id: 'older', groupId: 'source' },
    { ...tab, id: 'pending', groupId: 'btw' }
  ]
  const groups = [
    { ...group, id: 'source', tabOrder: ['parent', 'older'] },
    { ...group, id: 'btw', tabOrder: ['pending'] }
  ]
  const sideIds = new Set(['older', 'pending'])
  expect(sideChatPanePlacement(tabs, groups, sideIds, 'right', new Set(['older']))).toBeNull()
  expect(sideChatPanePlacement(tabs, groups, sideIds, 'right', sideIds)).toMatchObject({
    kind: 'move',
    tabId: 'older',
    groupId: 'btw'
  })
})
