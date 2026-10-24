import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import { getRuntimeEnvironmentStatus } from '@/runtime/runtime-rpc-client'
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from './pending-worktree-creation'
import type { AgentLaunchResult } from '../../../shared/agent-launch-intent'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'

const mocks = vi.hoisted(() => {
  const pendingWorktreeCreations: Record<string, unknown> = { 'creation-1': {} }
  return {
    capabilities: vi.fn(),
    rpc: vi.fn(),
    draft: vi.fn(),
    close: vi.fn(),
    reveal: vi.fn(),
    ready: vi.fn(),
    complete: vi.fn(),
    refresh: vi.fn(),
    terminalPrompt: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    seedTerminal: vi.fn(),
    state: {
      repos: [{ id: 'repo-1', executionHostId: 'local' }],
      settings: {},
      sortBy: 'manual',
      activeView: 'terminal',
      activePendingCreationId: 'creation-1',
      activeWorktreeId: null,
      pendingWorktreeCreations,
      updatePendingWorktreeCreation: vi.fn(),
      closeUnifiedTab: vi.fn(),
      seedNativeChatLaunchDraft: vi.fn(),
      seedNativeChatLaunchPrompt: vi.fn(),
      unifiedTabsByWorktree: { 'wt-1': [{ id: 'structured-agent-session-claude_created' }] }
    }
  }
})
vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.state, subscribe: mocks.subscribe }
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: mocks.capabilities
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.rpc,
  getRuntimeEnvironmentStatus: vi.fn()
}))
vi.mock('@/store/slices/worktrees/create/worktree-create-parent-pick', () => ({
  resolveWorktreeCreateParent: () => ({ staleBeforeCreate: false }),
  notifyWorktreeParentDropped: vi.fn()
}))
vi.mock('@/lib/worktree-creation-host-result', () => ({
  acceptHostCreatedWorktree: (_target: unknown, launch: AgentLaunchResult) => launch.created,
  materializeHostCreatedWorktree: mocks.refresh
}))
vi.mock('@/components/native-chat/native-chat-session-option-cache', () => ({
  seedNativeChatAppliedSessionOptions: vi.fn()
}))
vi.mock('@/runtime/structured-agent-session-tab-retirement', () => ({
  beginStructuredAgentSessionTabClose: mocks.close
}))
vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mocks.terminalPrompt
}))
vi.mock('@/runtime/web-runtime-session-tab-lifecycle', () => ({
  closeWebRuntimeSessionTab: vi.fn()
}))
vi.mock('@/lib/worktree-initial-terminal-seeding', () => ({
  ensureWorktreeHasInitialTerminal: mocks.seedTerminal
}))
vi.mock('@/lib/worktree-creation-background-mount', () => ({
  mountCreatedWorktreeStartupTabsInBackground: vi.fn()
}))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: mocks.reveal }))
vi.mock('@/lib/worktree-creation-ready-toast', () => ({
  showWorktreeCreationReadyToast: mocks.ready
}))
vi.mock('@/lib/worktree-creation-completion', () => ({ completeWorktreeCreation: mocks.complete }))

import {
  discardStructuredLaunchPrompts,
  dismissHostCreatedLaunchPrompt
} from './structured-agent-session-launch-prompt'
import { resetStructuredAgentSessionSendsForTests } from '@/components/native-chat/structured-agent-session-message-sender'
import { cancelDesktopCreateLaunch } from './structured-agent-session-desktop-create'
import { markStructuredAgentSessionLaunchCancelled } from './structured-agent-session-launch-registry'
import {
  readStructuredAgentLaunchRecord,
  hasStructuredAgentLaunchCancellationTombstonePersisted
} from './structured-agent-session-launch-persistence'
import { deriveAgentLaunchChildOperationId } from '../../../shared/agent-launch-child-operation'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { createWorktreeThroughHost } from './worktree-creation-through-host'

const capabilities = [
  'agent.launch.v2',
  'agent.launch.replay-required.v1',
  'agent.launch.surface.v1',
  'agent.launch.desktop-create.v1'
]
const result = {
  worktreeId: 'wt-1',
  created: { worktree: makeWorktree({ id: 'wt-1', repoId: 'repo-1' }) },
  outcome: { kind: 'structured', sessionId: 'claude_created', handle: 'chat_created' },
  receipt: {
    mode: 'structured',
    preferred: 'structured',
    reason: 'requested',
    detail: 'Chat requested'
  }
} satisfies AgentLaunchResult
function request(): WorktreeCreationRequest {
  return {
    repoId: 'repo-1',
    name: 'feature',
    setupDecision: 'inherit',
    agent: 'claude',
    agentLaunchRoute: 'structured-native-chat',
    pendingFirstAgentMessageRename: true,
    note: '',
    startupPlan: null,
    quickPrompt: 'Fix the bug',
    quickTelemetry: null
  }
}

const requests: WorktreeCreationRequest[] = []
afterEach(() => {
  for (const request of requests) {
    if (request.hostAgentLaunch) {
      discardStructuredLaunchPrompts(request.hostAgentLaunch.sessionId)
    }
  }
  requests.length = 0
  resetStructuredAgentSessionSendsForTests()
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.subscribe.mockReturnValue(mocks.unsubscribe)
  mocks.capabilities.mockResolvedValue(capabilities)
  mocks.rpc.mockImplementation(async (_target, _method, params) => ({
    ...result,
    outcome: { ...result.outcome, sessionId: params.sessionId }
  }))
  mocks.state.updatePendingWorktreeCreation.mockImplementation(
    (_id, { request }: { request: WorktreeCreationRequest }) => requests.push(request)
  )
  mocks.refresh.mockReset()
  mocks.terminalPrompt.mockResolvedValue(true)
  mocks.state.pendingWorktreeCreations = { 'creation-1': {} }
  mocks.state.activePendingCreationId = 'creation-1'
  mocks.state.seedNativeChatLaunchDraft = mocks.draft
})

describe('desktop shared worktree create', () => {
  it('passes the opening input to the host without a renderer send', async () => {
    const input = request()
    input.startupPlan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: input.quickPrompt,
      cmdOverrides: {},
      agentArgs: '--model sonnet',
      platform: 'darwin'
    })
    await expect(createWorktreeThroughHost('creation-1', input)).resolves.toBe(true)
    expect(mocks.rpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'agent.launchReplay',
      expect.objectContaining({
        operationId: expect.stringMatching(/^\d{13}-[0-9a-f]{32}$/),
        sessionId: expect.stringMatching(/^claude_/),
        surface: 'chat',
        agentArgs: '--model sonnet',
        target: {
          kind: 'create-worktree',
          create: expect.objectContaining({
            repo: 'repo-1',
            creationId: 'creation-1',
            pendingFirstAgentMessageRename: true
          })
        }
      }),
      { timeoutMs: 600_000, beforeSend: expect.any(Function) }
    )
    expect(mocks.rpc.mock.calls[0]?.[2].prompt).toEqual({ text: 'Fix the bug', delivery: 'submit' })
  })

  it('returns to the old renderer path before any effect if one required capability is absent', async () => {
    mocks.capabilities.mockResolvedValue(capabilities.slice(0, -1))
    const pending = request()
    await expect(createWorktreeThroughHost('creation-1', pending)).resolves.toBe(false)
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(pending.hostAgentLaunch).toBeUndefined()
  })

  it.each<Partial<WorktreeCreationRequest>>([
    { ephemeralVmCheckoutMode: 'provisioned-root' },
    { ephemeralVmRuntimeId: 'vm-1' },
    { ephemeralVmRecipe: { sourceRepoId: 'repo-1', recipeId: 'recipe-1', projectId: 'project-1' } }
  ])('keeps special workspace creation on its existing route: %j', async (specialCreate) => {
    await expect(
      createWorktreeThroughHost('creation-1', { ...request(), ...specialCreate })
    ).resolves.toBe(false)
    expect(mocks.capabilities).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('accepts dismissed host work without sending, closing or revealing it', async () => {
    mocks.rpc.mockImplementation(async (_target, _method, params) => {
      mocks.state.pendingWorktreeCreations = {}
      dismissHostCreatedLaunchPrompt(params.sessionId)
      return { ...result, outcome: { ...result.outcome, sessionId: params.sessionId } }
    })
    await createWorktreeThroughHost('creation-1', request())
    expect(mocks.subscribe).not.toHaveBeenCalled()
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect(mocks.close).not.toHaveBeenCalled()
    expect(mocks.reveal).not.toHaveBeenCalled()
    expect(mocks.ready).not.toHaveBeenCalled()
  })

  it('keeps moved-away creation in the background and places a draft in its chat composer', async () => {
    mocks.state.activePendingCreationId = 'other-creation'
    await createWorktreeThroughHost('creation-1', { ...request(), promptDelivery: 'draft' })
    expect(mocks.draft).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Fix the bug',
        tabId: expect.stringMatching(/^structured-agent-session-claude_/)
      })
    )
    expect(mocks.reveal).not.toHaveBeenCalled()
    expect(mocks.ready).toHaveBeenCalledOnce()
  })

  it.each(['before inventory', 'during inventory'])(
    'keeps the accepted host terminal after progress dismissal %s',
    async (checkpoint) => {
      mocks.rpc.mockImplementationOnce(async (_target, _method, params) => {
        if (checkpoint === 'before inventory') {
          mocks.state.pendingWorktreeCreations = {}
        }
        return {
          ...terminalResult(),
          outcome: { ...terminalResult().outcome, paneKey: params.paneKey }
        }
      })
      mocks.refresh.mockImplementationOnce(async () => {
        mocks.state.pendingWorktreeCreations = {}
      })
      await createWorktreeThroughHost('creation-1', request())
      expect(mocks.rpc).toHaveBeenCalledTimes(1)
      expect(mocks.terminalPrompt).not.toHaveBeenCalled()
      expect(mocks.reveal).not.toHaveBeenCalled()
    }
  )

  it.each(['draft', 'auto-submit'] as const)(
    'keeps %s terminal input in its original delivery mode',
    async (promptDelivery) => {
      mocks.rpc.mockImplementationOnce(async (_target, _method, params) => ({
        ...terminalResult(),
        outcome: { ...terminalResult().outcome, paneKey: params.paneKey }
      }))
      await createWorktreeThroughHost('creation-1', {
        ...request(),
        launchDraftPrompt: 'Investigate https://example.test/task/123',
        promptDelivery
      })
      if (promptDelivery === 'draft') {
        expect(mocks.terminalPrompt).toHaveBeenCalledWith(
          expect.objectContaining({
            agent: 'claude',
            content: 'Investigate https://example.test/task/123',
            submit: false,
            forcePaste: true
          })
        )
        await expect(mocks.terminalPrompt.mock.calls[0]?.[0].launchPty).resolves.toBe(
          'term_created'
        )
      } else {
        expect(mocks.terminalPrompt).not.toHaveBeenCalled()
        expect(mocks.state.seedNativeChatLaunchPrompt).toHaveBeenCalledWith(
          expect.objectContaining({ unconfirmed: true })
        )
        expect(mocks.draft).not.toHaveBeenCalled()
      }
    }
  )

  it('passes returned unspawned Setup to the existing fallback without replacing the agent', async () => {
    const setup = { runnerScriptPath: '/runner/setup', envVars: {} }
    mocks.rpc.mockImplementationOnce(async (_target, _method, params) => ({
      ...result,
      outcome: { ...result.outcome, sessionId: params.sessionId },
      created: { ...result.created, setup }
    }))
    await createWorktreeThroughHost('creation-1', request())
    expect(mocks.seedTerminal).toHaveBeenCalledWith(
      mocks.state,
      'wt-1',
      undefined,
      setup,
      undefined,
      undefined,
      { callerProvidesSurface: true, activateCreatedTabs: false }
    )
  })

  it('keeps the original input for a deliberate fresh Retry after a typed setup refusal', async () => {
    const pending = request()
    mocks.rpc.mockImplementationOnce(async () => {
      pending.quickPrompt = 'edited after issue'
      throw new RuntimeRpcCallError({
        id: 'refusal',
        ok: false,
        error: {
          code: 'worktree_create_setup_choice_required',
          message: 'Choose how to run Setup.'
        }
      })
    })
    await expect(createWorktreeThroughHost('creation-1', pending)).rejects.toThrow(
      'Choose how to run Setup.'
    )
    expect(pending.hostAgentLaunch).toBeUndefined()
    expect(mocks.draft).not.toHaveBeenCalled()
    await createWorktreeThroughHost('creation-1', pending)
    expect(mocks.rpc.mock.calls[1]?.[2].operationId).not.toBe(
      mocks.rpc.mock.calls[0]?.[2].operationId
    )
    expect(mocks.rpc.mock.calls[1]?.[2].prompt.text).toBe('Fix the bug')
  })

  it('replays a live outer request across proven same-host rotation, with one resolved request fence and blocked unresolved identities', async () => {
    const env = (revision: number) => [{ id: 'server-1', createdAt: 1, pairingRevision: revision }]
    replaceRuntimeEnvironmentRevisions(env(11))
    const status = createCompatibleRuntimeStatusResponse()
    if (!status.ok) {
      throw new Error('compatible status fixture failed')
    }
    vi.mocked(getRuntimeEnvironmentStatus).mockResolvedValue({ ...status.result, capabilities })
    const pending: WorktreeCreationRequest = { ...request(), executionHostId: 'runtime:server-1' }
    mocks.rpc.mockRejectedValueOnce(new Error('lost reply'))
    await expect(createWorktreeThroughHost('creation-1', pending)).rejects.toThrow('lost reply')
    const params = structuredClone(mocks.rpc.mock.calls[0]?.[2])
    replaceRuntimeEnvironmentRevisions(env(12), {
      retired: [],
      sameHost: [{ id: 'server-1', fromRevision: 11, toRevision: 12 }]
    })
    let dispatched = 0
    mocks.rpc.mockImplementationOnce(async (_target, _method, sent, options) => {
      options.beforeSend()
      dispatched++
      return { ...result, outcome: { ...result.outcome, sessionId: sent.sessionId } }
    })
    await createWorktreeThroughHost('creation-1', pending)
    expect(dispatched).toBe(1)
    expect(mocks.rpc.mock.calls[1]?.[2]).toEqual(params)
    expect(mocks.rpc.mock.calls[1]?.[3]).toMatchObject({ expectedEnvironmentPairingRevision: 12 })
    expect(mocks.refresh).toHaveBeenLastCalledWith(
      { kind: 'environment', environmentId: 'server-1' },
      'wt-1',
      12
    )
    const { markStructuredAgentLaunchCancelledPersisted } =
      await import('./structured-agent-session-launch-persistence')
    for (const retire of ['revision', 'close']) {
      let release!: () => void
      let entered!: () => void
      const compatibility = new Promise<void>((resolve) => {
        release = resolve
      })
      const waiting = new Promise<void>((resolve) => {
        entered = resolve
      })
      mocks.rpc.mockImplementationOnce(async (_target, _method, sent, options) => {
        entered()
        await compatibility
        options.beforeSend()
        dispatched++
        return { ...result, outcome: { ...result.outcome, sessionId: sent.sessionId } }
      })
      const attempt = createWorktreeThroughHost('creation-1', pending)
      await waiting
      if (retire === 'revision') {
        replaceRuntimeEnvironmentRevisions(env(13), {
          retired: [],
          sameHost: [{ id: 'server-1', fromRevision: 12, toRevision: 13 }]
        })
      } else {
        markStructuredAgentLaunchCancelledPersisted(
          pending.hostAgentLaunch!.sessionId,
          'runtime:server-1'
        )
      }
      release()
      await attempt
      expect(dispatched).toBe(1)
    }
    replaceRuntimeEnvironmentRevisions(env(14), {
      retired: [],
      sameHost: [],
      pending: [{ id: 'server-1', fromRevision: 13 }]
    })
    await expect(createWorktreeThroughHost('creation-1', pending)).rejects.toThrow(
      'Could not confirm'
    )
    replaceRuntimeEnvironmentRevisions(env(15), { retired: ['server-1'], sameHost: [] })
    await expect(createWorktreeThroughHost('creation-1', pending)).rejects.toThrow(
      'Could not confirm'
    )
    if (!pending.hostAgentLaunch) {
      throw new Error('live owner missing')
    }
    pending.hostAgentLaunch.pairingRevision = undefined
    await expect(createWorktreeThroughHost('creation-1', pending)).rejects.toThrow(
      'Could not confirm'
    )
    expect(mocks.rpc).toHaveBeenCalledTimes(4)
    replaceRuntimeEnvironmentRevisions([])
  })

  it('replays the same create after an unanswered call instead of minting another operation', async () => {
    mocks.rpc.mockRejectedValueOnce(
      new RuntimeRpcCallError({
        id: 'create-1',
        ok: false,
        error: {
          code: 'agent_session_operation_unknown',
          message: 'agent_session_operation_unknown'
        }
      })
    )
    const pending = request()
    await expect(createWorktreeThroughHost('creation-1', pending)).rejects.toThrow(
      'Could not confirm whether Claude created the workspace'
    )
    await createWorktreeThroughHost('creation-1', pending)
    expect(mocks.subscribe).not.toHaveBeenCalled()
    expect(mocks.rpc.mock.calls[1]?.[2]).toEqual(mocks.rpc.mock.calls[0]?.[2])
  })
  it('closes progress without retiring admitted chat, and prevents late revival after certified cancellation', async () => {
    for (const status of ['admitted', 'cancelled'] as const) {
      const response = Promise.withResolvers<AgentLaunchResult>()
      mocks.state.pendingWorktreeCreations = { 'creation-1': {} }
      const input = request()
      mocks.rpc.mockImplementation(async (_target, method, params) => {
        if (method === 'agent.launchCancel') {
          const child = deriveAgentLaunchChildOperationId(params.operationId)
          return {
            status,
            ...(status === 'admitted' && child
              ? { surfaceAdmitted: true, messageId: deriveAgentLaunchChildOperationId(child) }
              : {})
          }
        }
        return response.promise
      })
      const start = createWorktreeThroughHost('creation-1', input)
      await vi.waitFor(() => expect(input.hostAgentLaunch?.issued).toBe(true))
      const launch = input.hostAgentLaunch
      if (!launch) {
        throw new Error('missing launch')
      }
      mocks.state.pendingWorktreeCreations = {}
      dismissHostCreatedLaunchPrompt(launch.sessionId)
      await cancelDesktopCreateLaunch(launch)
      expect(mocks.rpc).toHaveBeenLastCalledWith(
        { kind: 'local' },
        'agent.launchCancel',
        launch.params,
        { beforeSend: expect.any(Function) }
      )
      expect(hasStructuredAgentLaunchCancellationTombstonePersisted(launch.sessionId)).toBe(false)
      expect(Boolean(readStructuredAgentLaunchRecord(launch.sessionId))).toBe(status === 'admitted')
      response.resolve({
        ...result,
        outcome: { ...result.outcome, sessionId: launch.sessionId },
        prompt: {
          delivery: 'submit',
          outcome: 'journaled',
          messageId:
            deriveAgentLaunchChildOperationId(
              deriveAgentLaunchChildOperationId(launch.operationId) ?? ''
            ) ?? ''
        }
      })
      await start
      expect(readStructuredAgentLaunchRecord(launch.sessionId)).toBeUndefined()
      expect(mocks.close).not.toHaveBeenCalled()
      expect(mocks.reveal).not.toHaveBeenCalled()
      expect(mocks.draft).not.toHaveBeenCalled()
    }
    expect(mocks.rpc.mock.calls.map((call) => call[1])).toEqual([
      'agent.launchReplay',
      'agent.launchCancel',
      'agent.launchReplay',
      'agent.launchCancel'
    ])

    const response = Promise.withResolvers<AgentLaunchResult>()
    const cancelReply = Promise.withResolvers<unknown>()
    mocks.state.pendingWorktreeCreations = { 'creation-1': {} }
    const input = request()
    mocks.rpc.mockImplementation(async (_target, method) =>
      method === 'agent.launchCancel' ? cancelReply.promise : response.promise
    )
    const start = createWorktreeThroughHost('creation-1', input)
    await vi.waitFor(() => expect(input.hostAgentLaunch?.issued).toBe(true))
    const launch = input.hostAgentLaunch
    if (!launch) {
      throw new Error('missing launch')
    }
    markStructuredAgentSessionLaunchCancelled('wt-1', launch.sessionId, 'local', {
      unifiedTabsByWorktree: {},
      groupsByWorktree: {},
      reorderUnifiedTabs: vi.fn()
    })
    expect(readStructuredAgentLaunchRecord(launch.sessionId)).toBeUndefined()
    expect(hasStructuredAgentLaunchCancellationTombstonePersisted(launch.sessionId)).toBe(true)
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      { kind: 'local' },
      'agent.launchCancel',
      launch.params,
      { beforeSend: expect.any(Function) }
    )
    const beforeSend = mocks.rpc.mock.calls.at(-1)?.[3]?.beforeSend
    expect(typeof beforeSend).toBe('function')
    beforeSend()
    cancelReply.resolve({ status: 'admitted', surfaceAdmitted: true })
    response.resolve({ ...result, outcome: { ...result.outcome, sessionId: launch.sessionId } })
    await start
    expect(readStructuredAgentLaunchRecord(launch.sessionId)).toBeUndefined()
    expect(mocks.reveal).not.toHaveBeenCalled()
    expect(mocks.draft).not.toHaveBeenCalled()
  })
})

function terminalResult(): AgentLaunchResult {
  return {
    ...result,
    outcome: {
      kind: 'terminal',
      handle: 'term_created',
      paneKey: 'terminal-created:11111111-1111-4111-8111-111111111111'
    }
  }
}
