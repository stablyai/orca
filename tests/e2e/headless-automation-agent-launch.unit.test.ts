import '../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import type { createChatRendererBridge } from './helpers/automation-chat-renderer-test-harness'
import { exerciseBusyChatReuse } from './helpers/automation-chat-reuse-test-harness'
import { readAutomationRunReceipt } from '../../src/main/automations/automation-run-receipt'
import {
  AUTOMATION_AGENT_CALLER,
  automationRunOperationId
} from '../../src/main/automations/automation-run-operation'
import { rpcCallerOperationKey } from '../../src/main/runtime/rpc/rpc-caller-identity'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  HOST_TEST_LOCATION
} from '../../src/main/native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import type { StructuredAgentSessionHost } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-host'
import { createQueuedMessageTestRig } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import type { AgentLaunchResult } from '../../src/shared/agent-launch-intent'
import { buildProfileStateCutoverFixture } from '../../src/main/persistence/profile-state-cutover-fixture'
import { launchAutomationChatAgent } from '../../src/main/automations/automation-chat-agent-launch'

const mocks = vi.hoisted(() => {
  const hostState: {
    actualHost: StructuredAgentSessionHost | null
    renderer: Awaited<ReturnType<typeof createChatRendererBridge>> | null
  } = { actualHost: null, renderer: null }
  return {
    ...hostState,
    hostAvailable: true,
    readChat: vi.fn<typeof callStructuredAgentSession>().mockResolvedValue({}),
    launch: vi.fn(),
    host: { journalSnapshot: vi.fn(), currentWork: vi.fn(), send: vi.fn() }
  }
})
vi.mock('../../src/main/runtime/rpc/methods/agent-launch', () => ({
  launchAgentOnHost: mocks.launch
}))
vi.mock('../../src/main/native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => mocks.actualHost ?? (mocks.hostAvailable ? mocks.host : null)
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: (...args: Parameters<typeof callStructuredAgentSession>) =>
    mocks.readChat(...args)
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (
    target: Parameters<NonNullable<typeof mocks.renderer>['call']>[0],
    method: string,
    params: unknown
  ) => {
    if (!mocks.renderer) {
      throw new Error('renderer not bound')
    }
    return mocks.renderer.call(target, method, params)
  },
  runtimeEnvironmentSupportsCapability: async () => true
}))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: () => true }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () =>
      mocks.renderer?.store.getState() ?? {
        settings: {},
        repos: [],
        worktreesByRepo: {},
        getTab: () => undefined,
        terminalLayoutsByTabId: {},
        ptyIdsByTabId: {}
      }
  }
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))
const state = buildProfileStateCutoverFixture('/fixture')
const run = { ...state.automationRuns[0], id: 'run-1', createdAt: Date.now() }
const automation = {
  ...state.automations[0],
  id: run.automationId,
  agentId: 'claude' as const,
  workspaceMode: 'existing' as const,
  workspaceId: 'wt-1',
  prompt: 'Audit',
  surface: 'chat' as const,
  extraAgentArgs: undefined
}
const target = { ok: true as const, repo: state.repos[0], cwd: '/fixture' }
const terminal: AgentLaunchResult = {
  worktreeId: 'wt-1',
  outcome: { kind: 'terminal', handle: 'term-1', paneKey: 'tab-1:leaf-1' },
  receipt: {
    mode: 'terminal',
    preferred: 'structured',
    reason: 'structured_unsupported_on_host',
    detail: 'Fallback'
  },
  prompt: { delivery: 'submit', outcome: 'handed-to-terminal' }
}
const chat: AgentLaunchResult = {
  ...terminal,
  outcome: { kind: 'structured', sessionId: 'claude_chat', handle: 'chat-tab' },
  prompt: { delivery: 'submit', outcome: 'journaled', messageId: 'first-message' }
}
function fixture() {
  const conversation = (id: string) => ({
    sessionId: id,
    provider: 'claude',
    location: { workspaceId: 'wt-1' },
    currentFence: 2
  })
  const records = {
    readOnly: false,
    selectWritableRecord: vi.fn((_id: string): { kind: 'writable' | 'missing' | 'unreadable' } => ({
      kind: 'writable'
    })),
    isSessionUnreadable: vi.fn(() => false),
    readCommandReceipt: vi.fn(() => ({ verdict: 'absent' })),
    getOperationRow: vi.fn(),
    getConversation: vi.fn<(id: string) => ReturnType<typeof conversation> | null>(conversation)
  }
  const runtime = {
    requireStore: () => ({
      getSettings: () => ({
        experimentalNativeChat: true,
        workspaceDir: '/fixture',
        nestWorkspaces: false,
        agentDefaultArgs: { claude: '--model sonnet --add-dir docs' }
      })
    }),
    showTerminalWorkspaceLaunchScope: vi.fn(async () => ({
      id: 'wt-1',
      path: '/fixture',
      connectionId: 'ssh-test'
    })),
    showManagedWorktree: vi.fn(async () => ({ displayName: 'Audit' })),
    showTerminal: vi.fn(async () => ({ tabId: 'tab-1' })),
    getTerminalPtyIdForHandle: vi.fn(() => 'pty-1'),
    getTerminalPaneKey: vi.fn(() => 'tab-1:leaf-1'),
    getTerminalHandleForPaneKey: vi.fn(() => 'term-prev'),
    getAgentStatusRowsForPane: vi.fn(() => [{ state: 'done', agentType: 'claude', receivedAt: 1 }]),
    ensureStructuredAgentSessionHost: vi.fn(),
    openAgentSessionRecordStore: vi.fn(async () => records)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the runtime boundaries above are reached; the ordinary launch is mocked separately.
  return { runtime: runtime as unknown as OrcaRuntimeService, records }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.actualHost = null
  mocks.hostAvailable = true
  mocks.launch.mockResolvedValue(terminal)
  mocks.host.currentWork.mockReturnValue({ working: () => false })
  mocks.host.send.mockResolvedValue({ ok: true })
})
describe('automations through agent.launch', () => {
  it.each(['claude', 'codex'] as const)(
    'launches explicit Chat for %s through the common entry and keeps its actual fallback',
    async (agentId) => {
      const { runtime } = fixture()
      const result = await launchAutomationChatAgent(runtime, {
        automation: { ...automation, agentId },
        run,
        target,
        runs: []
      })
      expect(mocks.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: agentId,
          surface: 'chat',
          operationId: automationRunOperationId(run, 'fresh-launch'),
          prompt: { text: 'Audit', delivery: 'submit' },
          presentation: 'background',
          target: { kind: 'existing', worktree: 'id:wt-1' }
        }),
        expect.objectContaining({ runtime }),
        expect.objectContaining({
          onSurfacePublished: expect.any(Function)
        })
      )
      expect(result).toMatchObject({
        workspaceDisplayName: 'Audit',
        sessionKind: 'terminal',
        chatSessionId: null,
        terminalPtyId: 'pty-1'
      })
    }
  )
  it('does not apply stored Terminal extras to Chat', async () => {
    const { runtime } = fixture()
    mocks.launch.mockResolvedValue(chat)
    await launchAutomationChatAgent(runtime, {
      automation: { ...automation, extraAgentArgs: '--model opus' },
      run,
      target,
      runs: []
    })
    expect(mocks.launch.mock.calls[0][0].agentArgs).toBeUndefined()
  })
  it('refuses an expired admission without minting another launch identity', async () => {
    const { runtime } = fixture()
    mocks.launch.mockRejectedValue(new Error('agent_session_operation_expired'))
    await expect(
      launchAutomationChatAgent(runtime, { automation, run, target, runs: [] })
    ).rejects.toThrow(
      'Claude could not start because this run waited too long. Run the automation again.'
    )
    expect(mocks.launch).toHaveBeenCalledTimes(1)
  })
  it('records the actual chat identity and delegates new workspace setup and provenance', async () => {
    const { runtime } = fixture()
    mocks.launch.mockResolvedValue(chat)
    const result = await launchAutomationChatAgent(runtime, {
      automation: {
        ...automation,
        surface: 'chat',
        workspaceMode: 'new_per_run',
        workspaceId: null,
        setupDecision: 'run'
      },
      run,
      target,
      runs: []
    })
    expect(mocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'chat',
        target: {
          kind: 'create-worktree',
          create: expect.objectContaining({
            setupDecision: 'run',
            activate: false,
            automationProvenanceRequest: expect.objectContaining({
              automationId: automation.id,
              automationRunId: run.id
            })
          })
        }
      }),
      expect.anything(),
      expect.anything()
    )
    expect(result).toMatchObject({
      sessionKind: 'chat',
      chatSessionId: 'claude_chat',
      terminalHandle: null,
      terminalPaneKey: null,
      terminalSessionId: null,
      terminalPtyId: null
    })
  })
  it('chooses the newest compatible Chat despite busy work and stale nonfinal history', async () => {
    const { runtime, records } = fixture()
    mocks.host.currentWork.mockReturnValue({ working: () => true })
    const previous = {
      ...run,
      id: 'newest',
      createdAt: run.createdAt + 10,
      status: 'dispatched' as const,
      workspaceId: 'stale-workspace',
      sessionKind: 'chat' as const,
      chatSessionId: 'claude_prev'
    }
    const result = await launchAutomationChatAgent(runtime, {
      automation: { ...automation, surface: 'chat', reuseSession: true },
      run,
      target,
      runs: [
        { ...previous, id: 'non-chat', createdAt: previous.createdAt + 1, sessionKind: 'terminal' },
        {
          ...previous,
          id: 'other-automation',
          automationId: 'other',
          createdAt: previous.createdAt + 2
        },
        { ...previous, id: run.id, createdAt: previous.createdAt + 3 },
        previous,
        { ...previous, id: 'duplicate', createdAt: run.createdAt },
        {
          ...previous,
          id: 'older-idle',
          chatSessionId: 'claude_idle',
          createdAt: run.createdAt - 1,
          status: 'completed'
        }
      ]
    })
    expect(result).toMatchObject({ chatSessionId: 'claude_prev', workspaceId: 'wt-1' })
    expect(records.getConversation).toHaveBeenCalledExactlyOnceWith('claude_prev')
    expect(mocks.host.send).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({
        delivery: 'queue-if-active',
        envelope: expect.objectContaining({
          sessionId: 'claude_prev',
          clientOperationId: automationRunOperationId(run, 'reuse-send'),
          expectedRuntimeFence: 2
        })
      })
    )
    expect(mocks.host.currentWork).not.toHaveBeenCalled()
    expect(mocks.host.journalSnapshot).not.toHaveBeenCalled()
    expect(mocks.launch).not.toHaveBeenCalled()
  })
  it('skips genuinely missing/incompatible records and never needs a current work projection', async () => {
    const { runtime, records } = fixture()
    mocks.host.currentWork.mockReturnValue(null)
    records.selectWritableRecord.mockImplementation((id) => ({
      kind: id === 'missing' ? 'missing' : 'writable'
    }))
    records.getConversation.mockImplementation((id) => ({
      sessionId: id,
      provider: 'claude',
      location: { workspaceId: id === 'moved' ? 'elsewhere' : 'wt-1' },
      currentFence: 2
    }))
    const runs = ['missing', 'moved', 'claude_prev'].map((id, n) => ({
      ...run,
      id,
      createdAt: run.createdAt - n - 1,
      status: 'dispatch_failed' as const,
      sessionKind: 'chat' as const,
      chatSessionId: id
    }))
    const request = {
      automation: { ...automation, surface: 'chat' as const, reuseSession: true },
      run,
      target,
      runs
    }
    expect((await launchAutomationChatAgent(runtime, request)).chatSessionId).toBe('claude_prev')
    expect(mocks.launch).not.toHaveBeenCalled()
    mocks.host.send.mockClear()
    mocks.launch.mockResolvedValue(chat)
    await launchAutomationChatAgent(runtime, { ...request, runs: runs.slice(0, 2) })
    expect(mocks.host.send).not.toHaveBeenCalled()
    expect(mocks.launch).toHaveBeenCalledOnce()
    expect(mocks.launch.mock.calls[0][0].operationId).toBe(
      automationRunOperationId(run, 'fresh-launch')
    )
  })
})

it.each(['terminal', 'chat'] as const)(
  'preserves published %s identity for refused, uncertain and throwing settlement',
  async (kind) => {
    const { runtime, records } = fixture()
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    const published =
      kind === 'chat'
        ? chat
        : { ...terminal, outcome: { kind: 'terminal' as const, handle: 'term-1', paneKey } }
    for (const outcome of ['not-delivered', 'unconfirmed', 'throw', 'accepted-throw'] as const) {
      mocks.launch.mockImplementationOnce(async (_params, _context, policy) => {
        policy.onSurfacePublished(published)
        if (outcome === 'accepted-throw') {
          records.getOperationRow.mockImplementation((_caller, id) =>
            id === automationRunOperationId(run, 'fresh-launch')
              ? { outcome: { status: 'succeeded', launch: published } }
              : undefined
          )
          throw new Error('accepted reply lost')
        }
        if (outcome === 'throw') {
          throw new Error('settlement transport lost')
        }
        return { ...published, prompt: { delivery: 'submit', outcome } }
      })
      const result = await launchAutomationChatAgent(runtime, {
        automation: {
          ...automation,
          surface: 'chat'
        },
        run,
        target,
        runs: []
      }).catch((error) => error)
      expect(outcome === 'accepted-throw' ? { target: result } : result).toMatchObject({
        target: {
          workspaceId: 'wt-1',
          sessionKind: kind === 'chat' ? 'chat' : 'terminal',
          ...(kind === 'chat'
            ? { chatSessionId: 'claude_chat', terminalPaneKey: null, terminalSessionId: null }
            : {
                terminalPaneKey: paneKey,
                terminalSessionId: 'tab-1',
                terminalPtyId: 'pty-1'
              })
        }
      })
    }
    expect(mocks.launch).toHaveBeenCalledTimes(4)
    expect(mocks.host.send).not.toHaveBeenCalled()
  }
)

it.each(['normal', 'lost-reply', 'restart'] as const)(
  'keeps busy Chat Q→S through %s, exact persisted output and normal Details',
  (mode) =>
    exerciseBusyChatReuse(mode, automation, target, {
      setHost: (host) => {
        mocks.actualHost = host
      },
      bindRenderer: (renderer) => {
        mocks.renderer = renderer
      },
      launch: mocks.launch
    })
)

it('retains a known identity when record/host preparation cannot prove availability', async () => {
  for (const failure of [
    'unreadable',
    'null-view',
    'read-failed',
    'read-only-missing',
    'host-absent',
    'host-failed'
  ] as const) {
    const { runtime, records } = fixture()
    mocks.host.send.mockClear()
    mocks.hostAvailable = failure !== 'host-absent'
    if (failure === 'unreadable') {
      records.selectWritableRecord.mockReturnValue({ kind: 'unreadable' })
    }
    if (failure === 'null-view') {
      records.getConversation.mockReturnValue(null)
    }
    if (failure === 'read-failed') {
      records.getConversation.mockImplementation(() => {
        throw new Error('unreadable disk')
      })
    }
    if (failure === 'read-only-missing') {
      records.readOnly = true
      records.selectWritableRecord.mockReturnValue({ kind: 'missing' })
    }
    if (failure === 'host-failed') {
      vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockRejectedValueOnce(
        new Error('host failed')
      )
    }
    await expect(
      launchAutomationChatAgent(runtime, {
        automation: { ...automation, surface: 'chat', reuseSession: true },
        run,
        target,
        runs: [{ ...run, id: 'old', sessionKind: 'chat', chatSessionId: 'claude_prev' }]
      })
    ).rejects.toMatchObject({ target: { sessionKind: 'chat', chatSessionId: 'claude_prev' } })
    expect(mocks.host.send).not.toHaveBeenCalled()
    expect(mocks.launch).not.toHaveBeenCalled()
  }
})

it.each(['before-admission', 'accepted-reply', 'accepted-lost-reply'] as const)(
  'permits fresh only for authoritative deletion %s',
  async (when) => {
    vi.spyOn(Date, 'now').mockReturnValue(HOST_TEST_NOW)
    const current = { ...run, createdAt: HOST_TEST_NOW }
    const rig = await createQueuedMessageTestRig({ restartable: true })
    mocks.actualHost = rig.host
    let removedRecord = rig.store.getRecord(HOST_TEST_SESSION)!
    const removeRecord = () =>
      rig.store['transact']((draft) => {
        removedRecord = draft.records.get(HOST_TEST_SESSION)!
        draft.records.delete(HOST_TEST_SESSION)
      })
    try {
      const { runtime } = fixture()
      vi.spyOn(runtime, 'openAgentSessionRecordStore').mockResolvedValue(rig.store)
      const sent = rig.host.send.bind(rig.host)
      const send = vi.spyOn(rig.host, 'send').mockImplementationOnce(async (...args) => {
        if (when === 'before-admission') {
          await removeRecord()
        }
        const reply = await sent(...args)
        if (when === 'before-admission') {
          expect(reply).toMatchObject({
            ok: false,
            refusal: {
              code: 'agent_session_ownership_unknown',
              details: { reason: 'sessionNotAttached' }
            }
          })
        } else {
          expect(reply.ok).toBe(true)
          await removeRecord()
          if (when === 'accepted-lost-reply') {
            throw new Error('accepted reply lost after deletion')
          }
        }
        return reply
      })
      mocks.launch.mockResolvedValue(chat)
      const attempt = launchAutomationChatAgent(runtime, {
        automation: {
          ...automation,
          agentId: 'codex',
          workspaceId: HOST_TEST_LOCATION.workspaceId,
          surface: 'chat',
          reuseSession: true
        },
        run: current,
        target,
        runs: [{ ...run, id: 'old', sessionKind: 'chat', chatSessionId: HOST_TEST_SESSION }]
      })
      if (when === 'accepted-lost-reply') {
        await expect(attempt).rejects.toMatchObject({
          target: { chatSessionId: HOST_TEST_SESSION }
        })
      } else {
        expect((await attempt).chatSessionId).toBe(
          when === 'before-admission' ? 'claude_chat' : HOST_TEST_SESSION
        )
      }
      const q = automationRunOperationId(current, 'reuse-send')
      expect(rig.store.readCommandReceipt({ kind: 'global' }, q).verdict).toBe('absent')
      expect(readAutomationRunReceipt(rig.store, current)).toBeNull()
      expect(
        rig.store.getOperationRow(rpcCallerOperationKey(AUTOMATION_AGENT_CALLER), q)?.outcome.status
      ).toBe(when === 'before-admission' ? undefined : 'succeeded')
      expect(send).toHaveBeenCalledOnce()
      expect(mocks.launch).toHaveBeenCalledTimes(when === 'before-admission' ? 1 : 0)
      if (when === 'before-admission') {
        expect(mocks.launch.mock.calls[0][0].operationId).toBe(
          automationRunOperationId(current, 'fresh-launch')
        )
      }
    } finally {
      mocks.actualHost = null
      // Restore the injected deletion only after assertions so ordinary host teardown can run.
      await rig.store['transact']((draft) => {
        draft.records.set(HOST_TEST_SESSION, removedRecord)
      })
      await rig.dispose()
    }
  }
)

it.each(['unknown', 'refused', 'conflict', 'failed-row'] as const)(
  'retains known reused Chat on %s acceptance without resending',
  async (acceptance) => {
    const { runtime, records } = fixture()
    mocks.host.send.mockImplementationOnce(async () => {
      if (acceptance === 'unknown') {
        throw new Error('transport lost')
      }
      return {
        ok: false,
        refusal: {
          code:
            acceptance === 'conflict' ? 'agent_session_conflict' : 'agent_session_operation_unknown'
        }
      }
    })
    records.getOperationRow.mockReturnValue(
      acceptance === 'failed-row' ? { outcome: { status: 'failed' } } : undefined
    )
    await expect(
      launchAutomationChatAgent(runtime, {
        automation: { ...automation, surface: 'chat', reuseSession: true },
        run,
        target,
        runs: [
          {
            ...run,
            id: 'old',
            status: 'completed',
            workspaceId: 'wt-1',
            sessionKind: 'chat',
            chatSessionId: 'claude_prev'
          }
        ]
      })
    ).rejects.toMatchObject({ target: { sessionKind: 'chat', chatSessionId: 'claude_prev' } })
    expect(mocks.host.send).toHaveBeenCalledOnce()
    expect(mocks.launch).not.toHaveBeenCalled()
  }
)

afterEach(() => vi.restoreAllMocks())
