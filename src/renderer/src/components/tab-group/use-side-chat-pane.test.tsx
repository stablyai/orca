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
import { openStructuredAgentSessionProvisionalTab } from '@/lib/structured-agent-session-launch-surface'
import {
  writeStructuredAgentLaunchRecord,
  deleteStructuredAgentLaunchRecord,
  resetStructuredAgentLaunchPersistenceForTests
} from '@/lib/agent-session/launch/structured-agent-session-launch-persistence'
import { notifyStructuredLaunchListeners } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { useSideChatPane } from './use-side-chat-pane'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
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
createStoreSessionMockApi()
let close = () => {}
const settle = () => layoutApplyTestTransport.settle()
const workspaceTabs = () => useAppStore.getState().unifiedTabsByWorktree[FOLDER_KEY] ?? []
const groupOf = (sessionId: string) =>
  workspaceTabs().find((tab) => tab.entityId === sessionId)?.groupId

beforeEach(async () => {
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
