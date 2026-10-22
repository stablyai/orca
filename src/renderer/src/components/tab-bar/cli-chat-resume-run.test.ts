// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliChatResumeSource } from './cli-chat-resume-source'
import type { AgentSessionWireRefusal } from '../../../../shared/agent-session-wire'
import type { StructuredAgentSessionCreateParams } from '../../../../shared/structured-agent-session-create'

const mocks = vi.hoisted(() => {
  const state: { source: CliChatResumeSource | null } = { source: null }
  return {
    ...state,
    sourceCapability: vi.fn(),
    createCapability: vi.fn(),
    call: vi.fn(),
    toast: vi.fn(),
    activate: vi.fn(async () => true)
  }
})
vi.mock('./cli-chat-resume-source', () => ({ resolveCliChatResumeSource: () => mocks.source }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  supportsStructuredAgentSessionCliSource: mocks.sourceCapability,
  supportsStructuredAgentSessionCreateMessage: mocks.createCapability,
  callStructuredAgentSession: (...args: unknown[]) =>
    args[1] === 'agentSession.createSupport'
      ? Promise.resolve({ supported: true })
      : mocks.call(...args)
}))
vi.mock('@/runtime/structured-session-tab-inventory', () => ({
  readStructuredSessionTabInventory: async () => {
    throw new Error('Reply unavailable')
  }
}))
vi.mock('@/lib/structured-agent-session-create-hydration', () => ({
  publishStructuredAgentSessionCreateHydration: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toast } }))
vi.mock('@/lib/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: mocks.activate
}))
// Switch-on, main opens the chat's tab and its frame draws it.
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

import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session-launch-plan'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/structured-agent-session-provisional-tab'
import {
  getStructuredAgentSessionLaunchLifecycle,
  retryStructuredAgentSessionLaunch
} from '@/lib/structured-agent-session-launch'
import {
  readStructuredAgentLaunchRecord,
  writeStructuredAgentLaunchRecord,
  resetStructuredAgentLaunchPersistenceForTests
} from '@/lib/structured-agent-session-launch-persistence'
import {
  reserveStructuredLaunchSlot,
  restoreStructuredLaunchSurfaces,
  stopStructuredLaunchSlotTracking
} from '@/lib/structured-agent-session-launch-surface'
import { applyStructuredSessionTabSnapshots } from '@/runtime/local-structured-session-tabs-sync/snapshot-apply'
import { resetLocalStructuredSessionVersionForTests } from '@/runtime/local-structured-session-tabs-sync/inventory-generation-fence'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '@/runtime/web-session-tabs-sync/tracking-lifecycle'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { buildHydratedTabState } from '@/store/slices/tabs-hydration'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { useAppStore } from '@/store'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { runCliChatResume } from './cli-chat-resume-run'
import {
  resetStructuredAgentLaunchRegistryForTests,
  structuredLaunchStates
} from '@/lib/structured-agent-session-launch-registry'
import { isEmptyWorkspaceDefaultSurfacePending } from '@/lib/empty-workspace-default-surface-claims'
import {
  clearWebSessionFocusIntent,
  peekWebSessionFocusIntent,
  resetWebSessionFocusIntentForTests
} from '@/runtime/web-session-focus-intent'
import { structuredAgentSessionFocusOwner } from '@/runtime/structured-agent-session-owner'
import { registerSessionTabIpcBridge } from '@/hooks/ipc-events/session-tab-ipc-bridge'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'

const SOURCE: CliChatResumeSource = {
  tabId: 'tab-1',
  workspaceId: 'wt-1',
  paneKey: 'tab-1:leaf',
  agent: 'claude',
  providerSessionId: 'provider-1',
  executionHostId: 'local'
}
const tabs = () => useAppStore.getState().unifiedTabsByWorktree['wt-1'] ?? []
let main: TabsDrawnFromMain | undefined
afterEach(() => {
  vi.unstubAllGlobals()
  main?.close()
  main = undefined
})
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function refuse(reason: 'transcriptNotFound' | 'transcriptUnreadable'): AgentSessionWireRefusal {
  return {
    code: 'agent_session_identity_required',
    message: 'private host error',
    details: { reason },
    createAttemptRefusedBeforeCommit: true
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
  stopStructuredLaunchSlotTracking()
  localStorage.clear()
  resetStructuredAgentLaunchPersistenceForTests()
  resetStructuredAgentLaunchRegistryForTests()
  resetWebSessionFocusIntentForTests()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({ activeWorktreeId: 'wt-1' })
  mocks.source = SOURCE
  mocks.sourceCapability.mockResolvedValue(true)
  mocks.createCapability.mockResolvedValue(true)
  mocks.call.mockImplementation(
    async (_target, method, params: StructuredAgentSessionCreateParams) => {
      expect(method).toBe('agentSession.create')
      return { ok: true, value: { sessionId: params.envelope.sessionId, fence: 1 } }
    }
  )
  main = await drawTabsFromMain(useAppStore)
})

function snapshot(sessionId?: string): RuntimeMobileSessionTabsResult {
  return {
    worktree: 'wt-1',
    publicationEpoch: 'publication-test',
    snapshotVersion: Date.now(),
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: sessionId
      ? [
          {
            type: 'agent-session',
            id: `agent-session:${sessionId}`,
            sessionId,
            agent: 'claude',
            title: 'Chat',
            isActive: false
          }
        ]
      : []
  }
}

/** Main takes the store's current layout, as after a restart; seeding after it is invisible to main. */
async function redrawFromMain(): Promise<void> {
  main?.close()
  main = await drawTabsFromMain(useAppStore)
}

async function seedTabs() {
  const seeded = ['E', 'S', 'B'].map((id) =>
    useAppStore.getState().createUnifiedTab('wt-1', 'editor', { id, entityId: id })
  )
  await redrawFromMain()
  return seeded
}

describe('CLI identity resume through the existing launch owner', () => {
  it('shares pending, sends only an advertised source, and survives source closure after dispatch', async () => {
    const reply = deferred<unknown>()
    mocks.call.mockReturnValue(reply.promise)
    const running = runCliChatResume(SOURCE)
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    await runCliChatResume({ ...SOURCE, paneKey: 'another-pane' })
    expect(mocks.call).toHaveBeenCalledOnce()
    expect(tabs()).toEqual([])
    expect(isEmptyWorkspaceDefaultSurfacePending('wt-1')).toBe(true)
    const params: StructuredAgentSessionCreateParams = mocks.call.mock.calls[0][2]
    expect(params.resumeFrom).toEqual({
      providerSessionId: 'provider-1',
      cliSource: { workspaceId: 'wt-1', paneKey: 'tab-1:leaf' }
    })
    mocks.source = null
    useAppStore.setState({})
    reply.resolve({ ok: true, value: { sessionId: params.envelope.sessionId, fence: 1 } })
    await running
    expect(tabs()).toHaveLength(1)
    expect(isEmptyWorkspaceDefaultSurfacePending('wt-1')).toBe(false)
  })

  it('retires an unsent click during create capability waiting, even if the same source returns', async () => {
    const capability = deferred<boolean>()
    mocks.createCapability.mockReturnValue(capability.promise)
    const running = runCliChatResume(SOURCE)
    await vi.waitFor(() => expect(mocks.createCapability).toHaveBeenCalledOnce())
    mocks.source = null
    useAppStore.setState({})
    await running
    mocks.source = SOURCE
    capability.resolve(true)
    await vi.waitFor(() => expect([...structuredLaunchStates()]).toHaveLength(0))
    expect(mocks.call).not.toHaveBeenCalled()
    expect(tabs()).toEqual([])
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('uses ID-only create for an older host and retains uncertainty without pre-commit proof', async () => {
    mocks.sourceCapability.mockResolvedValue(false)
    mocks.call.mockResolvedValue({
      ok: false,
      refusal: { code: 'agent_session_conflict', message: 'old host' }
    })
    await runCliChatResume(SOURCE, true)
    expect(mocks.call.mock.calls[0][2].resumeFrom).toEqual({ providerSessionId: 'provider-1' })
    expect(tabs()).toHaveLength(1)
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('keeps ordinary refusals hidden and distinguishes unsaved from unreadable content', async () => {
    for (const reason of ['transcriptNotFound', 'transcriptUnreadable'] as const) {
      mocks.call.mockResolvedValue({ ok: false, refusal: refuse(reason) })
      await runCliChatResume(SOURCE)
      expect(tabs()).toEqual([])
      expect([...structuredLaunchStates()]).toEqual([])
      expect(mocks.toast.mock.calls.at(-1)?.[0]).toMatch(
        reason === 'transcriptUnreadable' ? /couldn't open.*history/i : /hasn't saved/
      )
    }
  })

  it('keeps the terminal and directs a refused terminal writer to Session History', async () => {
    mocks.call.mockResolvedValue({
      ok: false,
      refusal: {
        code: 'agent_session_conflict',
        message: 'private host evidence',
        details: { reason: 'conversationHeldElsewhere' },
        createAttemptRefusedBeforeCommit: true
      }
    })
    await runCliChatResume(SOURCE, true)
    expect(mocks.toast).toHaveBeenCalledTimes(1)
    expect(mocks.toast.mock.calls[0]?.[0]).toMatch(
      /^Orca can't confirm Claude.* has exited in its terminal\. Stop what's running there or close the terminal, then open this conversation from Session History\.$/
    )
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(tabs()).toEqual([])
    expect([...structuredLaunchStates()]).toEqual([])
  })

  it('opens a proved owner only for the header, on the initiating host, without importing', async () => {
    const owner = { sessionId: 'owner-chat', workspaceId: 'owner-workspace' }
    mocks.call.mockResolvedValue({
      ok: false,
      refusal: {
        code: 'agent_session_conflict',
        message: 'owner',
        details: { reason: 'conversationHeldElsewhere', owner },
        createAttemptRefusedBeforeCommit: true
      }
    })
    await runCliChatResume(SOURCE)
    expect(mocks.toast).toHaveBeenCalledWith('Another chat is already holding this conversation.')
    expect(mocks.activate).not.toHaveBeenCalled()
    await runCliChatResume(SOURCE, true)
    expect(mocks.activate).toHaveBeenCalledWith({ structuredSession: owner }, undefined, {
      kind: 'local'
    })
    expect(tabs()).toEqual([])
  })

  it('keeps the eager History joiner failed and retryable after the hidden starter is refused', async () => {
    const reply = deferred<unknown>()
    mocks.call.mockReturnValue(reply.promise)
    const running = runCliChatResume(SOURCE)
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    const sessionId: string = mocks.call.mock.calls[0][2].envelope.sessionId
    const eager = beginStructuredAgentSessionProvisionalLaunch({
      hooks: {},
      plan: adoptAgentSessionLaunchVerdict({
        route: 'structured-native-chat',
        requestId: newAgentLaunchRequestId(),
        agent: 'claude',
        worktreeId: 'wt-1',
        executionHostId: 'local',
        resumeFrom: { providerSessionId: 'provider-1' }
      })
    })
    await vi.waitFor(() => expect(tabs()).toHaveLength(1))
    reply.resolve({ ok: false, refusal: refuse('transcriptUnreadable') })
    await Promise.all([running, eager?.settlement])
    expect(mocks.call).toHaveBeenCalledOnce()
    expect(getStructuredAgentSessionLaunchLifecycle('wt-1', sessionId)).toBe('failed')
    expect(readStructuredAgentLaunchRecord(sessionId)?.lifecycle).toBe('failed')
    mocks.call.mockResolvedValue({ ok: true, value: { sessionId, fence: 1 } })
    expect(retryStructuredAgentSessionLaunch('wt-1', sessionId)).toBe(true)
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    expect(mocks.call.mock.calls[1][2].envelope.sessionId).toBe(sessionId)
    await vi.waitFor(() =>
      expect(getStructuredAgentSessionLaunchLifecycle('wt-1', sessionId)).toBeNull()
    )
    expect(tabs()).toHaveLength(1)
  })

  it('still opens an eager History joiner after the terminal closes before create', async () => {
    const capability = deferred<boolean>()
    mocks.createCapability.mockReturnValue(capability.promise)
    const running = runCliChatResume(SOURCE)
    await vi.waitFor(() => expect(mocks.createCapability).toHaveBeenCalledOnce())
    const eager = beginStructuredAgentSessionProvisionalLaunch({
      hooks: {},
      plan: adoptAgentSessionLaunchVerdict({
        route: 'structured-native-chat',
        requestId: newAgentLaunchRequestId(),
        agent: 'claude',
        worktreeId: 'wt-1',
        executionHostId: 'local',
        resumeFrom: { providerSessionId: 'provider-1' }
      })
    })
    mocks.source = null
    useAppStore.setState({})
    capability.resolve(true)
    await Promise.all([running, eager?.settlement])
    expect(mocks.call).toHaveBeenCalledOnce()
    expect(mocks.call.mock.calls[0][2].resumeFrom).toEqual({ providerSessionId: 'provider-1' })
    expect(tabs()).toHaveLength(1)
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it.each([
    ['reply', 'B', 'B E S R', 'B E S D R'],
    ['inventory', 'E', 'S B R E', 'S B D R E'],
    ['reply', 'E', 'S B E R', 'S B D E R'],
    ['inventory', 'B', 'R S E B', 'R S E D B']
  ])(
    'keeps canonical membership through registered IPC (%s first, move %s to %s)',
    async (first, mover, requested, expected) => {
      const [e, source, browser] = await seedTabs()
      let move: Parameters<typeof window.api.ui.onMoveSessionTab>[0] = () => {}
      vi.stubGlobal('api', {
        ...window.api,
        ui: {
          ...window.api?.ui,
          onCloseSessionTab: () => () => {},
          onSessionTabCloseRequest: () => () => {},
          onMoveSessionTab: (callback: typeof move) => {
            move = callback
            return () => {}
          }
        }
      })
      registerSessionTabIpcBridge([])
      const reply = deferred<unknown>()
      mocks.call.mockReturnValue(reply.promise)
      const running = runCliChatResume(SOURCE)
      await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
      const sessionId: string = mocks.call.mock.calls[0][2].envelope.sessionId
      const slotId = `structured-agent-session-${sessionId}`
      const store = useAppStore.getState()
      const order = store.groupsByWorktree['wt-1'][0].tabOrder
      expect(order).toEqual([e.id, source.id, browser.id, slotId])
      const later = useAppStore
        .getState()
        .createUnifiedTab('wt-1', 'editor', { id: 'R', entityId: 'R' })
      await redrawFromMain()
      const beforeNoop = useAppStore.getState()
      move({
        kind: 'reorder',
        worktreeId: 'wt-1',
        targetGroupId: e.groupId,
        tabId: browser.id,
        tabOrder: [e.id, source.id, browser.id, later.id]
      })
      expect(useAppStore.getState()).toBe(beforeNoop)
      move({
        kind: 'reorder',
        worktreeId: 'wt-1',
        targetGroupId: e.groupId,
        tabId: mover,
        tabOrder: requested.split(' ')
      })
      const expectedOrder = expected.split(' ').map((id) => (id === 'D' ? slotId : id))
      expect(useAppStore.getState().groupsByWorktree['wt-1'][0].tabOrder).toEqual(expectedOrder)
      expect(readStructuredAgentLaunchRecord(sessionId)?.surfaceAddress).toEqual({
        worktreeId: 'wt-1',
        targetGroupId: e.groupId,
        precedingTabIds: expectedOrder.slice(0, expectedOrder.indexOf(slotId))
      })
      const other = useAppStore.getState().createUnifiedTab('wt-1', 'editor', {
        entityId: 'other',
        split: { splitDirection: 'right', sourceGroupId: e.groupId }
      })
      await redrawFromMain()
      clearWebSessionFocusIntent(structuredAgentSessionFocusOwner({ kind: 'local' }), 'wt-1')
      if (first === 'inventory') {
        applyStructuredSessionTabSnapshots([snapshot(sessionId)])
      }
      reply.resolve({ ok: true, value: { sessionId, fence: 1 } })
      await running
      expect(
        useAppStore.getState().groupsByWorktree['wt-1'].find((group) => group.id === e.groupId)
          ?.tabOrder
      ).toEqual(expectedOrder)
      expect(useAppStore.getState().activeGroupIdByWorktree['wt-1']).toBe(other.groupId)
      useAppStore.getState().moveUnifiedTabToGroup(slotId, other.groupId)
      applyStructuredSessionTabSnapshots([
        { ...snapshot(sessionId), snapshotVersion: Date.now() + 1 }
      ])
      expect(tabs().find((tab) => tab.entityId === sessionId)?.groupId).toBe(other.groupId)
    }
  )

  // Main's publish of a window's create places nothing switch-on, so the resume's own open must.
  it('opens a resumed chat once, through main, after the tab before its hidden slot', async () => {
    const [, , browser] = await seedTabs()
    await runCliChatResume(SOURCE)
    await main?.settle()
    const sessionId: string = mocks.call.mock.calls[0][2].envelope.sessionId
    const slotId = `structured-agent-session-${sessionId}`
    expect(tabs().find((tab) => tab.entityId === sessionId)?.id).toBe(slotId)
    expect(useAppStore.getState().groupsByWorktree['wt-1'][0].tabOrder.at(-1)).toBe(slotId)
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      expect(layoutApplyTestTransport.sentOfType('openAgentSessionTab')).toEqual([
        expect.objectContaining({ tabId: slotId, sessionId, afterTabId: browser.id })
      ])
    }
  })

  it.each([false, true])(
    'keeps overlapping requests in their canonical order (second finishes first: %s)',
    async (reverse) => {
      const initial = await seedTabs()
      const replies = [deferred<unknown>(), deferred<unknown>()]
      mocks.call
        .mockImplementationOnce(() => replies[0].promise)
        .mockImplementationOnce(() => replies[1].promise)
      const first = runCliChatResume(SOURCE)
      await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
      const secondSource = { ...SOURCE, providerSessionId: 'provider-2' }
      mocks.source = secondSource
      const second = runCliChatResume(secondSource)
      await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
      const ids: string[] = mocks.call.mock.calls.map((call) => call[2].envelope.sessionId)
      for (const index of reverse ? [1, 0] : [0, 1]) {
        replies[index].resolve({ ok: true, value: { sessionId: ids[index], fence: 1 } })
        await (index === 0 ? first : second)
      }
      expect(useAppStore.getState().groupsByWorktree['wt-1'][0].tabOrder).toEqual([
        ...initial.map((tab) => tab.id),
        ...ids.map((id) => `structured-agent-session-${id}`)
      ])
    }
  )

  it('restores a pending-only group as unknown without sending create or restoring focus', async () => {
    const record = {
      sessionId: 'reload-pending',
      executionHostId: 'local' as const,
      agent: 'claude' as const,
      lifecycle: 'pending' as const,
      clientOperationId: 'original-operation',
      payloadFingerprint: 'fingerprint',
      expectedRuntimeFence: null,
      surfaceAddress: { worktreeId: 'wt-1', precedingTabIds: [] }
    }
    writeStructuredAgentLaunchRecord(record)
    const firstGroup = vi.fn()
    const unsubscribe = useAppStore.subscribe((state) => {
      const group = state.groupsByWorktree['wt-1']?.[0]
      if (group) {
        firstGroup(group)
      }
    })
    reserveStructuredLaunchSlot(record)
    unsubscribe()
    expect(firstGroup).toHaveBeenCalledTimes(1)
    expect(firstGroup.mock.calls[0][0]).toMatchObject({
      tabOrder: ['structured-agent-session-reload-pending'],
      activeTabId: null
    })
    expect(firstGroup.mock.calls[0][0].recentTabIds ?? []).toEqual([])
    expect(tabs()).toHaveLength(0)
    const session = buildWorkspaceSessionPayload(useAppStore.getState())
    stopStructuredLaunchSlotTracking()
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentLaunchRegistryForTests()
    useAppStore.setState(useAppStore.getInitialState(), true)
    useAppStore.setState({
      ...buildHydratedTabState(session, new Set(['wt-1'])),
      worktreesByRepo: { repo: [makeWorktree({ id: 'wt-1', repoId: 'repo', hostId: 'local' })] }
    })
    await redrawFromMain()
    restoreStructuredLaunchSurfaces()
    restoreStructuredLaunchSurfaces()
    applyStructuredSessionTabSnapshots([snapshot()])
    await main?.settle()
    expect(mocks.call).not.toHaveBeenCalled()
    expect(
      peekWebSessionFocusIntent(structuredAgentSessionFocusOwner({ kind: 'local' }), 'wt-1')
    ).toBeNull()
    expect(tabs()).toHaveLength(1)
    expect(getStructuredAgentSessionLaunchLifecycle('wt-1', 'reload-pending')).toBe(
      'visibility-unknown'
    )
    expect(readStructuredAgentLaunchRecord('reload-pending')?.clientOperationId).toBe(
      'original-operation'
    )
    expect(useAppStore.getState().groupsByWorktree['wt-1'][0].recentTabIds ?? []).toEqual([])
  })
})
