// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type * as launchModule from '../structured-agent-session-launch-create-call'
import type { AgentSessionLaunchPlan } from '../agent-session-launch-plan'
import { adoptAgentSessionLaunchVerdict } from '../agent-session-launch-plan'
import { beginStructuredAgentSessionProvisionalLaunch } from './structured-agent-session-provisional-tab'
import { StructuredAgentSessionCreateRefusalError } from '../structured-agent-session-launch-errors'
import { act, renderHook } from '@testing-library/react'
import { useNativeChatProvisionalLaunch } from '@/components/native-chat/use-native-chat-provisional-launch'
import {
  getStructuredAgentSessionLaunchFailure,
  resetStructuredAgentLaunchRegistryForTests
} from '../structured-agent-session-launch-registry'
import { structuredSessionNotices } from '@/components/native-chat/native-chat-structured-session-notices'
import type { AgentTerminalLaunchCompletion } from '../structured-agent-session-launch-admission'
import {
  addNativeChatPendingAttachment,
  clearNativeChatPendingAttachmentsForTests
} from '@/components/native-chat/native-chat-pending-attachment-cache'
import { applyStructuredSessionTabSnapshots } from '@/runtime/local-structured-session-tabs-sync/snapshot-apply'
import { makeEmptyHostSnapshot } from '@/runtime/host-session-mirror-frame-fixtures'
import * as unlisted from '../structured-agent-session-unlisted-created-chats'
import { buildFullWorktreePurgeState } from '@/store/slices/worktrees/teardown/worktree-purge-state'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'
import { structuredAgentSessionTabId } from '../../../../shared/structured-agent-session-projection'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

const mocks = vi.hoisted(() => ({ text: '', focus: vi.fn(), toast: vi.fn(), launch: vi.fn() }))
vi.mock('../structured-agent-session-launch-create-call', async (original) => ({
  ...(await original<typeof launchModule>()),
  launchStructuredAgentSession: mocks.launch
}))
vi.mock('sonner', () => ({ toast: { info: mocks.toast, error: vi.fn() } }))
vi.mock('../focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('@/components/native-chat/native-chat-composer-draft-store', () => ({
  readNativeChatComposerDraft: () => ({ text: mocks.text, images: [] }),
  resolveNativeChatComposerDraftOwner: () => undefined,
  structuredAgentSessionDraftScopeKey: (id: string) => `agent-session:${id}`
}))

function terminalRecord(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

let refuse = (): void => {}

function planSettlingAs(error: StructuredAgentSessionCreateRefusalError): AgentSessionLaunchPlan {
  const refusal = new Promise<never>((_, reject) => {
    refuse = () => reject(error)
  })
  mocks.launch.mockReturnValue(refusal)
  return adoptAgentSessionLaunchVerdict({
    requestId: 'action',
    route: 'structured-native-chat',
    agent: 'claude',
    worktreeId: 'wt-1',
    executionHostId: 'local'
  })
}

let main: TabsDrawnFromMain

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.text = ''
  resetStructuredAgentLaunchRegistryForTests()
  clearNativeChatPendingAttachmentsForTests()
  useAppStore.setState({
    activeWorktreeId: 'wt-1',
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    tabsByWorktree: {},
    tabBarOrderByWorktree: {}
  })
  main = await drawTabsFromMain(useAppStore)
})

afterEach(() => main.close())

async function mainLoadsStoreLayout(): Promise<void> {
  main.close()
  main = await drawTabsFromMain(useAppStore)
}

function pinAsUser(tabId: string): void {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    useAppStore.getState().pinTab(tabId)
    return
  }
  const worktreeId = useAppStore.getState().getTab(tabId)?.worktreeId ?? 'wt-1'
  sendLayoutCommandToOwner(
    worktreeId,
    { type: 'setTabProps', tabId, isPinned: true },
    { apply: () => {}, asToday: () => useAppStore.getState().pinTab(tabId) }
  )
}

function labelAsUser(tabId: string, label: string, color: string): void {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    useAppStore.getState().setTabCustomLabel(tabId, label)
    useAppStore.getState().setUnifiedTabColor(tabId, color)
    return
  }
  const asToday = { apply: () => {}, asToday: () => {} }
  sendLayoutCommandToOwner(
    'wt-1',
    { type: 'renameTab', tabId, kind: 'custom', title: label },
    asToday
  )
  sendLayoutCommandToOwner('wt-1', { type: 'setTabProps', tabId, color }, asToday)
}

function groupOf(tabId: string): string {
  const groupId = useAppStore.getState().getTab(tabId)?.groupId
  if (!groupId) {
    throw new Error(`No drawn tab ${tabId}`)
  }
  return groupId
}

function openChat(requestedSurface?: 'chat') {
  let complete!: (value: AgentTerminalLaunchCompletion) => void
  const completion = new Promise<AgentTerminalLaunchCompletion>((resolve) => {
    complete = resolve
  })
  const fallback = vi.fn(() => ({ opened: true, completion }))
  const launch = beginStructuredAgentSessionProvisionalLaunch({
    plan: {
      ...planSettlingAs(new StructuredAgentSessionCreateRefusalError('no')),
      requestedSurface
    },
    hooks: {},
    focusIntent: { request: mocks.focus, cancel: vi.fn() },
    onHostDeclined: fallback
  })
  const chat = launch?.tab
  if (!chat) {
    throw new Error('No immediate chat')
  }
  return { launch, chat, fallback, complete }
}

describe('a provisional structured chat tab', () => {
  it.each([
    'empty',
    'typed-before',
    'typed-during',
    'pending-chip',
    'failed',
    'unreconciled',
    'closed',
    'explicit',
    'away-before',
    'away-during',
    'closed-during'
  ])('owns the destination through terminal completion: %s', async (scenario) => {
    if (scenario === 'typed-before') {
      mocks.text = 'keep this'
    }
    const { launch, chat, fallback, complete } = openChat(
      scenario === 'explicit' ? 'chat' : undefined
    )
    await main.settle()
    expect(mocks.focus).toHaveBeenCalledWith(chat.id)
    const view = renderHook(() => {
      const current = useNativeChatProvisionalLaunch('wt-1', chat.entityId)
      return structuredSessionNotices({
        launch: current,
        agentLabel: 'Claude',
        sessionError: null,
        composerError: null
      })
    })
    const away = () => {
      useAppStore.getState().createUnifiedTab('wt-2', 'agent-session', { entityId: 'other' })
      useAppStore.setState({ activeWorktreeId: 'wt-2', activeTabType: 'agent-session' })
    }
    if (scenario === 'away-before') {
      away()
    }
    if (scenario === 'closed') {
      useAppStore.getState().closeUnifiedTab(chat.id)
    }
    await main.settle()
    refuse()
    await vi.waitFor(() =>
      expect(
        scenario === 'closed' || scenario === 'explicit' || fallback.mock.calls.length
      ).toBeTruthy()
    )
    if (scenario === 'closed' || scenario === 'explicit') {
      await launch?.settlement
      expect(fallback).not.toHaveBeenCalled()
      view.unmount()
      return
    }
    expect(useAppStore.getState().unifiedTabsByWorktree['wt-1']).toContainEqual(
      expect.objectContaining({ ...chat, contentType: 'agent-session' })
    )
    // Move the source while its host is preparing the terminal, then invest in the composer.
    const sibling = useAppStore.getState().createUnifiedTab('wt-1', 'terminal', {
      entityId: 'sibling',
      split: { sourceGroupId: groupOf(chat.id), splitDirection: 'right', activate: true }
    })
    const groupId = sibling.groupId
    const siblingRecords = () =>
      ORCA_LAYOUT_OWNER_IS_MAIN ? [terminalRecord(sibling.entityId)] : []
    useAppStore.setState({ tabsByWorktree: { 'wt-1': siblingRecords() } })
    await mainLoadsStoreLayout()
    const pinnedSource = scenario === 'empty' || scenario === 'typed-during'
    if (pinnedSource) {
      pinAsUser(chat.id)
      pinAsUser(sibling.id)
      labelAsUser(chat.id, 'My work', '#ff0000')
    }
    useAppStore.getState().moveUnifiedTabToGroup(chat.id, groupId)
    useAppStore.getState().reorderUnifiedTabs(groupId, [chat.id, sibling.id])
    if (scenario === 'typed-during') {
      mocks.text = 'new thought'
    }
    if (scenario === 'pending-chip') {
      addNativeChatPendingAttachment(`agent-session:${chat.entityId}`, {
        id: 'paste',
        path: '',
        pending: true
      })
    }
    if (scenario === 'away-during') {
      away()
    }
    if (scenario === 'closed-during') {
      useAppStore.getState().closeUnifiedTab(chat.id)
    }
    await main.settle()
    if (pinnedSource) {
      useAppStore.getState().activateTab(chat.id)
      useAppStore.getState().setActiveTabType('agent-session', 'wt-1')
    }
    const priorFailure = getStructuredAgentSessionLaunchFailure('wt-1', chat.entityId)
    const terminal =
      scenario === 'failed' || scenario === 'unreconciled'
        ? null
        : useAppStore
            .getState()
            .createUnifiedTab('wt-1', 'terminal', { id: 'replacement', activate: false })
    if (terminal) {
      useAppStore.setState({
        tabsByWorktree: { 'wt-1': [terminalRecord(terminal.entityId), ...siblingRecords()] }
      })
      if (scenario === 'typed-before') {
        useAppStore.getState().pinTab(terminal.id)
      }
    }
    await mainLoadsStoreLayout()
    const selected = useAppStore.getState().getActiveTab('wt-2')
    const interaction = vi.fn()
    useAppStore.setState({ recordFeatureInteraction: interaction })
    await act(async () => {
      complete({
        outcome:
          scenario === 'failed' ? { status: 'failed', message: 'offline' } : { status: 'created' },
        tabId: terminal?.id ?? 'missing'
      })
      await launch?.settlement
      await main.settle()
    })
    expect(interaction).not.toHaveBeenCalled()
    const state = useAppStore.getState()
    const tabs = state.unifiedTabsByWorktree['wt-1'] ?? []
    expect(tabs.some((t) => t.id === chat.id)).toBe(
      !['empty', 'away-before', 'away-during', 'closed-during'].includes(scenario)
    )
    if (terminal) {
      const order = state.groupsByWorktree['wt-1']?.find((g) => g.id === groupId)?.tabOrder
      expect(order).toEqual(
        scenario === 'closed-during'
          ? [sibling.id, terminal.id]
          : ['empty', 'away-before', 'away-during'].includes(scenario)
            ? [terminal.id, sibling.id]
            : [chat.id, terminal.id, sibling.id]
      )
      expect(mocks.toast).toHaveBeenCalledOnce()
      expect(state.getTab(terminal.id)?.isPinned ?? false).toBe(pinnedSource)
      expect(state.tabsByWorktree['wt-1'][0].isPinned ?? false).toBe(pinnedSource)
      if (pinnedSource) {
        const replaced = scenario === 'empty'
        expect(state.getTab(terminal.id)).toMatchObject({
          customLabel: replaced ? 'My work' : null,
          color: replaced ? '#ff0000' : null
        })
        expect(state.tabsByWorktree['wt-1'][0]).toMatchObject({
          customTitle: replaced ? 'My work' : null,
          color: replaced ? '#ff0000' : null
        })
        expect(state.getTab(chat.id)?.customLabel ?? null).toBe(replaced ? null : 'My work')
        expect(state.getTab(chat.id)?.color ?? null).toBe(replaced ? null : '#ff0000')
        expect(state.activeGroupIdByWorktree['wt-1']).toBe(groupId)
        expect(state.groupsByWorktree['wt-1'].find((g) => g.id === groupId)?.activeTabId).toBe(
          replaced ? terminal.id : chat.id
        )
        expect(state.activeTabType).toBe(replaced ? 'terminal' : 'agent-session')
      }
    }
    expect(view.result.current[0]?.text ?? '').not.toMatch(/open the agent|open it in/i)
    if (scenario === 'unreconciled') {
      expect(getStructuredAgentSessionLaunchFailure('wt-1', chat.entityId)).not.toBe(priorFailure)
      const notice = view.result.current[0]?.text
      expect(notice).toContain("couldn't show it here when the launch finished")
      act(() => {
        useAppStore.getState().createUnifiedTab('wt-1', 'terminal', {
          id: 'missing',
          activate: false
        })
      })
      expect(useAppStore.getState().getTab(chat.id)).not.toBeNull()
      expect(fallback).toHaveBeenCalledOnce()
      expect(mocks.launch).toHaveBeenCalledOnce()
      expect(view.result.current[0]?.text).toBe(notice)
      expect(mocks.toast).not.toHaveBeenCalled()
    }
    if (scenario.startsWith('away-')) {
      expect(state.activeWorktreeId).toBe('wt-2')
      expect(state.activeTabType).toBe('agent-session')
      expect(state.getActiveTab('wt-2')).toEqual(selected)
    }
    view.unmount()
  })

  // Hidden launch slots exist only in window order; count terminal position among tabs both window and main draw.
  it("places a declined chat's terminal right after the chat past a hidden launch slot", async () => {
    const { launch, chat, fallback, complete } = openChat()
    await main.settle()
    refuse()
    await vi.waitFor(() => expect(fallback).toHaveBeenCalled())
    const chatGroupId = groupOf(chat.id)
    const state = useAppStore.getState()
    const sibling = state.createUnifiedTab('wt-1', 'terminal', {
      entityId: 'sibling',
      targetGroupId: chatGroupId,
      activate: false
    })
    const terminal = state.createUnifiedTab('wt-1', 'terminal', {
      id: 'replacement',
      targetGroupId: chatGroupId,
      activate: false
    })
    useAppStore.setState({
      tabsByWorktree: {
        'wt-1': ORCA_LAYOUT_OWNER_IS_MAIN
          ? [terminalRecord(sibling.entityId), terminalRecord(terminal.entityId)]
          : []
      }
    })
    await mainLoadsStoreLayout()
    const slot = structuredAgentSessionTabId('hidden-launch')
    useAppStore.getState().ensureWorktreeRootGroup('wt-1', {
      tabId: slot,
      targetGroupId: chatGroupId,
      precedingTabIds: []
    })
    const order = () =>
      useAppStore.getState().groupsByWorktree['wt-1']?.find((g) => g.id === chatGroupId)?.tabOrder
    expect(order()).toEqual([slot, chat.id, sibling.id, terminal.id])

    await act(async () => {
      complete({ outcome: { status: 'created' }, tabId: terminal.id })
      await launch?.settlement
      await main.settle()
    })

    expect(useAppStore.getState().getTab(chat.id)).toBeNull()
    expect(order()?.filter((id) => id !== slot)).toEqual([terminal.id, sibling.id])
  })
})

afterEach(() => vi.useRealTimers())
it.each(['expiry', 'purge'])('created pane publication: %s', async (order) => {
  const store = () => useAppStore.getState()
  const source = store().createUnifiedTab('wt-1', 'agent-session', { entityId: 'b' })
  const groupId = store().createEmptySplitGroup('wt-1', source.groupId, 'right')!
  const chat = store().createUnifiedTab('wt-1', 'agent-session', {
    entityId: 'created',
    targetGroupId: groupId
  })
  const list = (snapshotVersion: number) =>
    applyStructuredSessionTabSnapshots([
      {
        ...makeEmptyHostSnapshot('wt-1'),
        publicationEpoch: chat.entityId,
        snapshotVersion,
        tabs: ['b'].map((sessionId) => ({
          type: 'agent-session',
          id: `agent-session:${sessionId}`,
          sessionId,
          agent: 'claude',
          title: 'Chat',
          isActive: false
        }))
      }
    ])
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  unlisted.recordUnlistedCreatedChat('wt-1', chat.entityId, 'local')
  list(100)
  expect(store().unifiedTabsByWorktree['wt-1']?.find((t) => t.id === chat.id)).toMatchObject({
    groupId
  })
  if (order === 'purge') {
    useAppStore.setState(buildFullWorktreePurgeState(store(), [{ id: 'wt-1' }]))
  }
  await vi.advanceTimersByTimeAsync(30_000)
  expect(unlisted.isUnlistedCreatedChat('wt-1', chat.entityId)).toBe(false)
  if (order === 'purge') {
    expect(store().unifiedTabsByWorktree['wt-1']).toBeUndefined()
  } else {
    expect(store().unifiedTabsByWorktree['wt-1']?.some((t) => t.id === chat.id)).toBe(true)
    list(101)
    expect(store().unifiedTabsByWorktree['wt-1']?.some((t) => t.id === chat.id)).toBe(
      ORCA_LAYOUT_OWNER_IS_MAIN
    )
  }
})
