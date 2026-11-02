// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { executeWorktreeCreation } from './worktree-creation-flow-execute'
import { retryBackgroundWorktreeCreation } from './worktree-creation-flow'
import {
  makeCreatedAgentWorktree,
  seedEmptyActivatableWorktree
} from './worktree-activation-created-agent.test-fixture'
import type { WorktreeCreationRequest } from './pending-worktree-creation'
import type { StructuredLaunchAdmission } from './agent-session/launch/structured-agent-session-host-admission'
import type * as admissionModule from './agent-session/launch/structured-agent-session-host-admission'
import type * as launchModule from './agent-session/launch/structured-agent-session-launch-create-call'
import type * as clientModule from '@/runtime/structured-agent-session-client'
import {
  getStructuredLaunchStateBySessionId,
  resetStructuredAgentLaunchRegistryForTests
} from './agent-session/launch/structured-agent-session-launch-registry'
import { StructuredAgentSessionCreateRefusalError } from './agent-session/launch/structured-agent-session-launch-errors'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from '@/components/native-chat/native-chat-composer-draft-store'
import { pendingCreationChatDraftScopeKey } from './pending-worktree-creation'
import { hasStagedStructuredLaunchPrompt } from './agent-session/launch/structured-agent-session-launch-prompt'
import { toast } from 'sonner'

const mocks = vi.hoisted(() => ({
  admission: vi.fn<typeof admissionModule.admitStructuredLaunchOnHost>(),
  createSession: vi.fn<typeof launchModule.launchStructuredAgentSession>(),
  // Whether this machine's host accepts a new workspace's launch and owns its Setup wait.
  hostAccepts: false,
  hostLaunch: vi.fn((_method: string, _params: unknown): Promise<unknown> => new Promise(() => {})),
  // Which of the route probe and the create reached a host, in order.
  order: [] as string[]
}))
vi.mock('@/runtime/structured-agent-session-client', async (original) => {
  const client = await original<typeof clientModule>()
  return {
    ...client,
    structuredAgentSessionHostSupports: (
      ...args: Parameters<typeof client.structuredAgentSessionHostSupports>
    ) =>
      args[1] === 'agent.launch.accept.v1'
        ? (mocks.order.push('probe'), Promise.resolve(mocks.hostAccepts))
        : client.structuredAgentSessionHostSupports(...args)
  }
})
vi.mock('./agent-session/launch/structured-agent-session-host-admission', async (original) => ({
  ...(await original<typeof admissionModule>()),
  admitStructuredLaunchOnHost: mocks.admission
}))
vi.mock('./agent-session/launch/structured-agent-session-launch-create-call', async (original) => ({
  ...(await original<typeof launchModule>()),
  launchStructuredAgentSession: mocks.createSession
}))
vi.mock('@/runtime/runtime-rpc-client', async (original) => {
  const client = (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await original())
  return {
    ...client,
    callRuntimeRpc: (...args: Parameters<typeof client.callRuntimeRpc>) =>
      args[1].startsWith('agent.launch')
        ? mocks.hostLaunch(args[1], args[2])
        : client.callRuntimeRpc(...args)
  }
})
vi.mock('@/runtime/runtime-layout-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await original())
)

const initialState = useAppStore.getState()
const worktree = makeCreatedAgentWorktree()
const request: WorktreeCreationRequest = {
  repoId: worktree.repoId,
  name: 'feature',
  setupDecision: 'skip',
  agent: 'codex',
  agentLaunchRoute: 'structured-native-chat',
  pendingFirstAgentMessageRename: false,
  note: '',
  startupPlan: null,
  quickPrompt: 'Fix the flaky test',
  quickTelemetry: null
}
let main: TabsDrawnFromMain

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.order.length = 0
  resetStructuredAgentLaunchRegistryForTests()
  seedEmptyActivatableWorktree(worktree)
  useAppStore.setState({
    activeWorktreeId: 'previous-worktree',
    activePendingCreationId: 'creation-1',
    pendingWorktreeCreations: {
      'creation-1': {
        creationId: 'creation-1',
        phase: 'creating',
        status: 'creating',
        startedAt: 1,
        indeterminate: false,
        loaderVisible: true,
        request
      }
    },
    createWorktree: vi.fn().mockResolvedValue({ worktree })
  })
  mocks.admission.mockResolvedValue({ kind: 'admitted' })
  mocks.createSession.mockReturnValue(new Promise(() => {}))
  mocks.hostAccepts = false
  mocks.hostLaunch.mockImplementation(async (method) =>
    method === 'agent.launchAccept' ? { state: 'running' } : new Promise(() => {})
  )
  main = await drawTabsFromMain(useAppStore)
})

afterEach(() => {
  main.close()
  clearNativeChatComposerDraftsForTests()
  resetStructuredAgentLaunchRegistryForTests()
  useAppStore.setState(initialState, true)
})

describe('creation chat handoff', () => {
  it.skipIf(!ORCA_LAYOUT_OWNER_IS_MAIN)(
    'owns input through delayed host admission and replacement tab publication',
    async () => {
      const emptyRequest = { ...request, quickPrompt: '' }
      useAppStore.getState().updatePendingWorktreeCreation('creation-1', {
        request: emptyRequest,
        heldChatMessage: 'First message accepted before launch'
      })
      const scope = pendingCreationChatDraftScopeKey('creation-1')
      updateNativeChatComposerDraft(scope, { text: 'Unsent follow-up', images: [] }, 'immediate')
      const admission = Promise.withResolvers<StructuredLaunchAdmission>()
      mocks.admission.mockImplementation(() => {
        expect(
          useAppStore.getState().pendingWorktreeCreations['creation-1']?.chatInputHandedOff
        ).toBe(true)
        return admission.promise
      })
      layoutApplyTestTransport.answerWith((command) =>
        command.type === 'openAgentSessionTab' ? 'pending' : 'apply'
      )

      const completion = executeWorktreeCreation('creation-1', emptyRequest)
      await vi.waitFor(() => expect(mocks.admission).toHaveBeenCalled())
      expect(readNativeChatComposerDraft(scope).text).toBe('Unsent follow-up')

      admission.resolve({ kind: 'admitted' })
      await vi.waitFor(() => expect(mocks.createSession).toHaveBeenCalled())
      const intent = mocks.createSession.mock.calls[0][0]
      expect(hasStagedStructuredLaunchPrompt(intent.sessionId)).toBe(true)
      expect(
        readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(intent.sessionId)).text
      ).toBe('Unsent follow-up')
      expect(useAppStore.getState().activePendingCreationId).toBe('creation-1')
      expect(
        useAppStore.getState().pendingWorktreeCreations['creation-1']?.chatInputHandedOff
      ).toBe(true)

      layoutApplyTestTransport.answerWith('apply')
      layoutApplyTestTransport.answerPending()
      await completion
      expect(useAppStore.getState().pendingWorktreeCreations['creation-1']).toBeUndefined()
      expect(
        readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(intent.sessionId)).text
      ).toBe('Unsent follow-up')
    }
  )

  it.skipIf(!ORCA_LAYOUT_OWNER_IS_MAIN)(
    'waits for the answering layout frame even when provider creation fails first',
    async () => {
      layoutApplyTestTransport.answerWith((command) =>
        command.type === 'openAgentSessionTab' ? 'pending' : 'apply'
      )
      mocks.createSession.mockRejectedValue(new StructuredAgentSessionCreateRefusalError('no'))

      const completion = executeWorktreeCreation('creation-1', request)
      await vi.waitFor(() => expect(layoutApplyTestTransport.pendingCount).toBe(1))
      await vi.waitFor(() => expect(mocks.createSession).toHaveBeenCalled())
      const intent = mocks.createSession.mock.calls[0][0]
      await vi.waitFor(() =>
        expect(getStructuredLaunchStateBySessionId(intent.sessionId)?.callers.outcome).toBe(
          'failed'
        )
      )
      expect(useAppStore.getState().activeWorktreeId).toBe('previous-worktree')
      expect(useAppStore.getState().activePendingCreationId).toBe('creation-1')

      layoutApplyTestTransport.answerWith('apply')
      layoutApplyTestTransport.answerPending()
      await completion
      expect(useAppStore.getState().activeWorktreeId).toBe(worktree.id)
      expect(useAppStore.getState().getActiveTab(worktree.id)?.contentType).toBe('agent-session')
      expect(useAppStore.getState().pendingWorktreeCreations['creation-1']).toBeUndefined()
    }
  )

  it.skipIf(!ORCA_LAYOUT_OWNER_IS_MAIN)(
    'preserves the held first message in a terminal when layout refuses the chat',
    async () => {
      const emptyRequest = { ...request, quickPrompt: '' }
      useAppStore.getState().updatePendingWorktreeCreation('creation-1', {
        request: emptyRequest,
        heldChatMessage: 'Recover this first message'
      })
      layoutApplyTestTransport.answerWith((command) =>
        command.type === 'openAgentSessionTab'
          ? { ok: false, code: 'pane_structure_changed' }
          : 'apply'
      )

      await executeWorktreeCreation('creation-1', emptyRequest)
      await main.settle()

      const state = useAppStore.getState()
      expect(state.pendingWorktreeCreations['creation-1']).toBeUndefined()
      expect(state.tabsByWorktree[worktree.id]).toHaveLength(1)
      expect(state.getActiveTab(worktree.id)?.contentType).toBe('terminal')
      const tabId = state.tabsByWorktree[worktree.id]![0]!.id
      expect(state.pendingStartupByTabId[tabId]).toMatchObject({
        command: expect.stringContaining('Recover this first message')
      })
    }
  )

  it('finishes creation when the host opens a terminal instead of a chat', async () => {
    mocks.admission.mockResolvedValue({ kind: 'declined' })

    await executeWorktreeCreation('creation-1', request)
    await main.settle()

    const state = useAppStore.getState()
    expect(state.activeWorktreeId).toBe(worktree.id)
    expect(state.pendingWorktreeCreations['creation-1']).toBeUndefined()
    expect(state.getActiveTab(worktree.id)?.contentType).toBe('terminal')
    expect(state.tabsByWorktree[worktree.id]).toHaveLength(1)
    expect(mocks.createSession).not.toHaveBeenCalled()
  })

  it('dismisses a pending admission without opening a late chat', async () => {
    const admission = Promise.withResolvers<StructuredLaunchAdmission>()
    mocks.admission.mockReturnValue(admission.promise)

    const completion = executeWorktreeCreation('creation-1', request)
    await vi.waitFor(() => expect(mocks.admission).toHaveBeenCalled())
    useAppStore.getState().removePendingWorktreeCreation('creation-1')
    await completion

    admission.resolve({ kind: 'admitted' })
    await main.settle()
    expect(useAppStore.getState().activeWorktreeId).toBe('previous-worktree')
    expect(useAppStore.getState().unifiedTabsByWorktree[worktree.id] ?? []).toEqual([])
    expect(mocks.createSession).not.toHaveBeenCalled()
  })

  const accepted = (): Record<string, unknown>[] =>
    mocks.hostLaunch.mock.calls
      .filter(([method]) => method === 'agent.launchAccept')
      .map(([, params]) => params as Record<string, unknown>)

  it.each([
    ['an older host keeps its own chat create', false, undefined, undefined],
    [
      'a host that owns Setup is handed the launch instead',
      true,
      { required: true, runId: 'setup-run-1' },
      { required: true, runId: 'setup-run-1' }
    ],
    [
      'a host that owns Setup keeps the launch when its reply says nothing of Setup',
      true,
      undefined,
      { required: true, runId: null }
    ]
  ])('%s', async (_case, hostAccepts, reported, setupReceipt) => {
    mocks.hostAccepts = hostAccepts
    const createWorktree = vi.fn(async (..._args: unknown[]) => {
      mocks.order.push('create')
      return { worktree, ...(reported ? { agentLaunchSetup: reported } : {}) }
    })
    useAppStore.setState({ createWorktree })

    await executeWorktreeCreation('creation-1', request)
    await main.settle()

    // The route is chosen before anything is created, and only that route promises the host a chat.
    expect(mocks.order).toEqual(['probe', 'create'])
    const createOptions = createWorktree.mock.calls[0]!.at(-1)
    if (hostAccepts) {
      expect(createOptions).toMatchObject({ promisedAgentChat: true })
    } else {
      expect(createOptions).not.toHaveProperty('promisedAgentChat')
    }

    await vi.waitFor(() =>
      expect(hostAccepts ? accepted() : mocks.createSession.mock.calls).toHaveLength(1)
    )
    expect(mocks.createSession).toHaveBeenCalledTimes(hostAccepts ? 0 : 1)
    expect(accepted()).toHaveLength(hostAccepts ? 1 : 0)
    // Only an older host is asked before Setup whether it runs the chat.
    expect(mocks.admission).toHaveBeenCalledTimes(hostAccepts ? 0 : 1)
    const chat = useAppStore.getState().getActiveTab(worktree.id)
    expect(chat?.contentType).toBe('agent-session')
    if (hostAccepts) {
      expect(accepted()[0]).toMatchObject({
        sessionId: chat?.entityId,
        prompt: { text: 'Fix the flaky test', delivery: 'submit' },
        presentation: 'focused',
        setupReceipt
      })
    } else {
      expect(mocks.createSession.mock.calls[0]![0].hostLaunch).toBeUndefined()
    }
    expect(useAppStore.getState().pendingWorktreeCreations['creation-1']).toBeUndefined()
  })

  it.skipIf(!ORCA_LAYOUT_OWNER_IS_MAIN)(
    "keeps a host launch's input when the layout refuses its chat, and Retry adopts that launch",
    async () => {
      mocks.hostAccepts = true
      const text = 'Recover this first message'
      const emptyRequest = { ...request, quickPrompt: '' }
      const scope = pendingCreationChatDraftScopeKey('creation-1')
      useAppStore.getState().updatePendingWorktreeCreation('creation-1', {
        request: emptyRequest,
        heldChatMessage: text
      })
      updateNativeChatComposerDraft(scope, { text: 'Unsent follow-up', images: [] }, 'immediate')
      const createWorktree = vi.fn().mockResolvedValue({ worktree })
      useAppStore.setState({ createWorktree })
      layoutApplyTestTransport.answerWith((command) =>
        command.type === 'openAgentSessionTab' ? { ok: false, code: 'tab_exists' } : 'apply'
      )

      await executeWorktreeCreation('creation-1', emptyRequest)
      await main.settle()
      const refused = useAppStore.getState().pendingWorktreeCreations['creation-1']
      expect(refused).toMatchObject({
        status: 'error',
        heldChatMessage: text,
        chatInputHandedOff: false,
        worktreeId: worktree.id
      })
      expect(readNativeChatComposerDraft(scope).text).toBe('Unsent follow-up')
      expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toEqual([])
      const hostLaunch = refused?.hostLaunch
      expect(hostLaunch).toBeDefined()

      layoutApplyTestTransport.answerWith('apply')
      retryBackgroundWorktreeCreation('creation-1')
      await vi.waitFor(() =>
        expect(useAppStore.getState().pendingWorktreeCreations['creation-1']).toBeUndefined()
      )
      await vi.waitFor(() => expect(accepted().length).toBeGreaterThan(0))
      expect(createWorktree).toHaveBeenCalledOnce()
      expect(mocks.createSession).not.toHaveBeenCalled()
      for (const params of accepted()) {
        expect(params).toMatchObject({
          operationId: hostLaunch?.operationId,
          sessionId: hostLaunch?.sessionId,
          prompt: { text, delivery: 'submit' }
        })
      }
      expect(useAppStore.getState().getActiveTab(worktree.id)?.entityId).toBe(hostLaunch?.sessionId)
      expect(
        readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(hostLaunch!.sessionId)).text
      ).toBe('Unsent follow-up')
    }
  )
})

it.skipIf(!ORCA_LAYOUT_OWNER_IS_MAIN)(
  'keeps a background host launch on its creation when the layout refuses its chat, and Retry adopts that launch',
  async () => {
    mocks.hostAccepts = true
    const text = 'Recover this first message'
    const emptyRequest = { ...request, quickPrompt: '' }
    const scope = pendingCreationChatDraftScopeKey('creation-1')
    // The user left the creation behind before its workspace was ready.
    useAppStore.setState({ activePendingCreationId: null, activeView: 'terminal' })
    useAppStore.getState().updatePendingWorktreeCreation('creation-1', {
      request: emptyRequest,
      heldChatMessage: text
    })
    updateNativeChatComposerDraft(scope, { text: 'Unsent follow-up', images: [] }, 'immediate')
    const createWorktree = vi.fn().mockResolvedValue({ worktree })
    useAppStore.setState({ createWorktree })
    const notice = vi.spyOn(toast, 'error')
    layoutApplyTestTransport.answerWith((command) =>
      command.type === 'openAgentSessionTab' ? { ok: false, code: 'tab_exists' } : 'apply'
    )

    await executeWorktreeCreation('creation-1', emptyRequest)
    await main.settle()
    const refused = useAppStore.getState().pendingWorktreeCreations['creation-1']
    expect(refused).toMatchObject({
      status: 'error',
      heldChatMessage: text,
      chatInputHandedOff: false,
      worktreeId: worktree.id
    })
    expect(readNativeChatComposerDraft(scope).text).toBe('Unsent follow-up')
    // Said in a short notice; the user stays where they went.
    expect(notice).toHaveBeenCalledOnce()
    notice.mockRestore()
    expect(useAppStore.getState().activeWorktreeId).toBe('previous-worktree')
    const hostLaunch = refused!.hostLaunch!

    // Retry adopts the same launch in the same workspace, which then fails its Setup.
    layoutApplyTestTransport.answerWith('apply')
    mocks.hostLaunch.mockImplementation(async (method) =>
      method === 'agent.launchAccept'
        ? { state: 'running' }
        : { state: 'failed', code: 'agent_launch_setup_not_completed' }
    )
    retryBackgroundWorktreeCreation('creation-1')
    await vi.waitFor(() =>
      expect(useAppStore.getState().pendingWorktreeCreations['creation-1']).toBeUndefined()
    )
    await vi.waitFor(() =>
      expect(getStructuredLaunchStateBySessionId(hostLaunch.sessionId)?.callers.outcome).toBe(
        'failed'
      )
    )
    expect(createWorktree).toHaveBeenCalledOnce()
    expect(mocks.createSession).not.toHaveBeenCalled()
    for (const [, params] of mocks.hostLaunch.mock.calls.filter(
      ([method]) => method === 'agent.launchAccept'
    )) {
      expect(params).toMatchObject({
        operationId: hostLaunch.operationId,
        sessionId: hostLaunch.sessionId,
        prompt: { text, delivery: 'submit', clientMessageId: hostLaunch.clientMessageId }
      })
    }
    const chatDraft = readNativeChatComposerDraft(
      structuredAgentSessionDraftScopeKey(hostLaunch.sessionId)
    ).text
    expect(chatDraft).toContain(text)
    expect(chatDraft).toContain('Unsent follow-up')
  }
)
