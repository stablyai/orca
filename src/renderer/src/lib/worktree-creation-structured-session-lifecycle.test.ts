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
  getStructuredAgentSessionLaunchFailure,
  getStructuredAgentSessionLaunchLifecycle,
  getStructuredLaunchStateBySessionId,
  resetStructuredAgentLaunchRegistryForTests
} from './agent-session/launch/structured-agent-session-launch-registry'
import { resetStructuredAgentLaunchPersistenceForTests } from './agent-session/launch/structured-agent-session-launch-persistence'
import {
  retryStructuredAgentSessionLaunch,
  startStructuredAgentLaunch
} from './agent-session/launch/structured-agent-session-launch'
import { newAgentLaunchRequestId } from './agent-launch-request-id'
import { requiredSetupLaunchFailureText } from './required-setup-launch-failure'
import { restoreStructuredLaunchSurfaces } from './agent-session/launch/structured-agent-session-launch-restore'
import { resetStructuredAgentSessionSendsForTests } from '@/components/native-chat/structured-agent-session-message-sender'
import { closeDismissedHostLaunch, pendingChatDraftScopeKey } from './worktree-creation-host-launch'
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
  order: [] as string[],
  // Every method this window asked a host.
  rpc: [] as string[]
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
      mocks.rpc.push(args[1]) &&
      (args[1].startsWith('agent.launch') || args[1] === 'agentSession.history')
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
  mocks.rpc.length = 0
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
})

const LAUNCHES = 'orca:structuredAgentLaunches:v1'
const HELD = 'Recover this first message'
const FOLLOW_UP = 'Unsent follow-up'
type HostAnswer = 'succeeded' | 'failed' | 'unknown'

const acceptCalls = (): Record<string, unknown>[] =>
  mocks.hostLaunch.mock.calls
    .filter(([method]) => method === 'agent.launchAccept')
    .map(([, params]) => params as Record<string, unknown>)
const savedLaunch = (sessionId: string): Record<string, unknown> | undefined =>
  (JSON.parse(localStorage.getItem(LAUNCHES) ?? '[]') as Record<string, unknown>[]).find(
    (row) => row.sessionId === sessionId
  )
const chatTabs = (sessionId: string) =>
  (useAppStore.getState().unifiedTabsByWorktree[worktree.id] ?? []).filter(
    (tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId
  )
const lifecycleOf = (sessionId: string) =>
  getStructuredAgentSessionLaunchLifecycle(worktree.id, sessionId)
const sessionDraft = (sessionId: string): string =>
  readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(sessionId)).text

/** What the host's status read says of the launch, in the shapes the host sends. */
function hostAnswer(answer: HostAnswer, sessionId: string): unknown {
  if (answer === 'failed') {
    return { state: 'failed', code: 'agent_launch_setup_not_completed' }
  }
  if (answer === 'unknown') {
    return { state: 'unknown' }
  }
  return {
    state: 'succeeded',
    result: {
      outcome: { kind: 'structured', sessionId, handle: 'chat' },
      worktreeId: worktree.id,
      receipt: { mode: 'structured', preferred: 'structured', reason: 'user_default', detail: '' },
      prompt: { delivery: 'submit', outcome: 'journaled', messageId: 'host-message' }
    }
  }
}

/** The host's answers: accept runs, each read gives `status()`, and the chat's tail has a fence. */
function hostReplies(status: () => Promise<unknown>): void {
  const cursor = { epoch: 'epoch-1', sequence: 1 }
  mocks.hostLaunch.mockImplementation(async (method, params) => {
    if (method === 'agent.launchAccept') {
      return { state: 'running' }
    }
    if (method === 'agentSession.history') {
      const { sessionId } = params as { sessionId: string }
      const window = { oldest: null, newest: null, nextCursor: cursor }
      const page = { sessionId, epoch: 'epoch-1', fence: 3, direction: 'tail', items: [], window }
      return {
        ok: true,
        page: {
          ...page,
          removedItemIds: [],
          submissions: [],
          liveCursor: cursor,
          hasOlder: false,
          hasNewer: false,
          latestTurn: null
        }
      }
    }
    return status()
  })
}

/** A new workspace's chat whose host accepted its launch while the layout had yet to answer the
 *  chat's tab, then refused it. */
async function refuseAcceptedChat(foreground: boolean, beforeRefusal?: HostAnswer) {
  mocks.hostAccepts = true
  const emptyRequest = { ...request, quickPrompt: '' }
  if (!foreground) {
    useAppStore.setState({ activePendingCreationId: null })
  }
  useAppStore.getState().updatePendingWorktreeCreation('creation-1', {
    request: emptyRequest,
    heldChatMessage: HELD
  })
  const scope = pendingCreationChatDraftScopeKey('creation-1')
  updateNativeChatComposerDraft(scope, { text: FOLLOW_UP, images: [] }, 'immediate')
  const createWorktree = vi.fn().mockResolvedValue({ worktree })
  useAppStore.setState({ createWorktree })
  const settled = Promise.withResolvers<unknown>()
  hostReplies(() => settled.promise)
  const notice = vi.spyOn(toast, 'error')
  layoutApplyTestTransport.answerWith((command) =>
    command.type === 'openAgentSessionTab' ? 'pending' : 'apply'
  )
  const completion = executeWorktreeCreation('creation-1', emptyRequest)
  await vi.waitFor(() => expect(acceptCalls()).toHaveLength(1))
  const launch = useAppStore.getState().pendingWorktreeCreations['creation-1']!.hostLaunch!
  // Saved where a reload finds it before the host could act on it: workspace, host, operation,
  // and the held message under the id the host was given.
  expect(savedLaunch(launch.sessionId)).toMatchObject({
    surfaceAddress: { worktreeId: worktree.id },
    executionHostId: 'local',
    agent: 'codex',
    hostLaunchOperationId: launch.operationId,
    lifecycle: 'pending',
    firstMessage: { clientMessageId: launch.clientMessageId }
  })
  if (beforeRefusal) {
    settled.resolve(hostAnswer(beforeRefusal, launch.sessionId))
    await vi.waitFor(() =>
      expect(getStructuredLaunchStateBySessionId(launch.sessionId)?.callers.outcome).toBe(
        beforeRefusal === 'failed' ? 'failed' : 'published'
      )
    )
  }
  layoutApplyTestTransport.answerWith((command) =>
    command.type === 'openAgentSessionTab' ? { ok: false, code: 'tab_exists' } : 'apply'
  )
  layoutApplyTestTransport.answerPending()
  await completion
  await main.settle()
  const entry = useAppStore.getState().pendingWorktreeCreations['creation-1']!
  expect(entry).toMatchObject({ status: 'error', heldChatMessage: HELD, worktreeId: worktree.id })
  expect(chatTabs(launch.sessionId)).toEqual([])
  // The draft stays in the launch's own saved chat, which the creation's composer shows meanwhile.
  expect(pendingChatDraftScopeKey(entry)).toBe(
    structuredAgentSessionDraftScopeKey(launch.sessionId)
  )
  expect(sessionDraft(launch.sessionId)).toContain(FOLLOW_UP)
  // Out of view, the existing short notice says so; the user stays where they went.
  expect(notice).toHaveBeenCalledTimes(foreground ? 0 : 1)
  notice.mockRestore()
  layoutApplyTestTransport.answerWith('apply')
  const settle = (answer: HostAnswer) => settled.resolve(hostAnswer(answer, launch.sessionId))
  return { launch, createWorktree, settle }
}

/** A renderer reload: memory and the session-only creation go; saved rows, drafts and tabs stay. */
function reloadWindow(): void {
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
  resetStructuredAgentSessionSendsForTests()
  useAppStore.setState({ pendingWorktreeCreations: {}, activePendingCreationId: null })
}

/** Nothing new reached a host: one workspace, one accept, no chat create, send or terminal. */
function expectNothingStartedTwice(createWorktree: ReturnType<typeof vi.fn>): void {
  expect(createWorktree).toHaveBeenCalledOnce()
  expect(acceptCalls()).toHaveLength(1)
  expect(mocks.createSession).not.toHaveBeenCalled()
  expect(mocks.rpc).not.toContain('agentSession.create')
  expect(mocks.rpc).not.toContain('agentSession.send')
  const state = useAppStore.getState()
  expect(
    (state.unifiedTabsByWorktree[worktree.id] ?? []).filter((tab) => tab.contentType === 'terminal')
  ).toEqual([])
  expect(state.pendingStartupByTabId).toEqual({})
}

/** Retry twice on a failed host launch's chat: each only reads launch `operationId` again, which
 *  stays failed, and the held message is given back once. */
async function expectRetryRereadsOnly(sessionId: string, operationId: string): Promise<void> {
  for (const _click of [1, 2]) {
    const before = mocks.hostLaunch.mock.calls.length
    expect(retryStructuredAgentSessionLaunch(worktree.id, sessionId)).toBe(true)
    await vi.waitFor(() => expect(lifecycleOf(sessionId)).toBe('failed'))
    expect(mocks.hostLaunch.mock.calls.slice(before)).toEqual([
      ['agent.launchStatus', expect.objectContaining({ operationId })]
    ])
    // The host's own recorded failure: Setup did not finish.
    expect(getStructuredAgentSessionLaunchFailure(worktree.id, sessionId)).toEqual({
      kind: 'not-started',
      causeText: requiredSetupLaunchFailureText('Codex')
    })
    expect(sessionDraft(sessionId).split(HELD)).toHaveLength(2)
    expect(sessionDraft(sessionId)).toContain(FOLLOW_UP)
  }
}

describe('retrying a host launch that failed', () => {
  afterEach(() => {
    resetStructuredAgentLaunchPersistenceForTests()
    localStorage.removeItem(LAUNCHES)
  })

  it('reads that same launch again, while a new chat still starts in the workspace', async () => {
    mocks.hostAccepts = true
    const emptyRequest = { ...request, quickPrompt: '' }
    useAppStore.getState().updatePendingWorktreeCreation('creation-1', {
      request: emptyRequest,
      heldChatMessage: HELD
    })
    updateNativeChatComposerDraft(
      pendingCreationChatDraftScopeKey('creation-1'),
      { text: FOLLOW_UP, images: [] },
      'immediate'
    )
    const createWorktree = vi.fn().mockResolvedValue({ worktree })
    useAppStore.setState({ createWorktree })
    hostReplies(async () => hostAnswer('failed', ''))
    await executeWorktreeCreation('creation-1', emptyRequest)
    await main.settle()
    const { sessionId, operationId } = acceptCalls()[0] as {
      sessionId: string
      operationId: string
    }
    await vi.waitFor(() => expect(lifecycleOf(sessionId)).toBe('failed'))
    expect(chatTabs(sessionId)).toHaveLength(1)

    await expectRetryRereadsOnly(sessionId, operationId)
    expectNothingStartedTwice(createWorktree)

    // After fixing Setup, the user's own new chat is a separate launch with its own create.
    const reads = mocks.hostLaunch.mock.calls.length
    const manual = startStructuredAgentLaunch(worktree.id, 'codex', {
      requestId: newAgentLaunchRequestId(),
      prompt: 'Setup is fixed now'
    })
    expect(manual.sessionId).not.toBe(sessionId)
    await vi.waitFor(() => expect(mocks.createSession).toHaveBeenCalledOnce())
    const created = mocks.createSession.mock.calls[0]![0]
    expect(created).toMatchObject({ worktreeId: worktree.id, sessionId: manual.sessionId })
    expect(created.hostLaunch).toBeUndefined()
    expect(mocks.hostLaunch.mock.calls).toHaveLength(reads)
    expect(lifecycleOf(sessionId)).toBe('failed')
  })
})

describe.skipIf(!ORCA_LAYOUT_OWNER_IS_MAIN)('a host launch whose chat the layout refused', () => {
  afterEach(() => {
    resetStructuredAgentLaunchPersistenceForTests()
    localStorage.removeItem(LAUNCHES)
  })

  it.each([
    ['foreground', true],
    ['background', false]
  ] as const)(
    'keeps its launch and input for Retry, which shows that same launch (%s)',
    async (_focus, foreground) => {
      const { launch, createWorktree, settle } = await refuseAcceptedChat(foreground)
      expect(useAppStore.getState().activeWorktreeId).toBe('previous-worktree')

      // Refused again: the same launch and its row stay, owed to the next Retry.
      layoutApplyTestTransport.answerWith((command) =>
        command.type === 'openAgentSessionTab' ? { ok: false, code: 'tab_exists' } : 'apply'
      )
      retryBackgroundWorktreeCreation('creation-1')
      await vi.waitFor(() =>
        expect(useAppStore.getState().pendingWorktreeCreations['creation-1']?.status).toBe('error')
      )
      await main.settle()
      expect(savedLaunch(launch.sessionId)).toMatchObject({ lifecycle: 'pending' })
      expect(sessionDraft(launch.sessionId)).toBe(FOLLOW_UP)

      layoutApplyTestTransport.answerWith('apply')
      retryBackgroundWorktreeCreation('creation-1')
      await vi.waitFor(() =>
        expect(useAppStore.getState().pendingWorktreeCreations['creation-1']).toBeUndefined()
      )
      await main.settle()
      expect(chatTabs(launch.sessionId)).toHaveLength(1)
      expect(lifecycleOf(launch.sessionId)).toBe('pending')
      expect(sessionDraft(launch.sessionId)).toBe(FOLLOW_UP)
      // The shown chat adopts the host's: no row is left behind.
      settle('succeeded')
      await vi.waitFor(() => expect(lifecycleOf(launch.sessionId)).toBeNull())
      expect(savedLaunch(launch.sessionId)).toBeUndefined()
      expectNothingStartedTwice(createWorktree)
    }
  )

  it('gives both texts back in the shown chat when the host fails after the refusal', async () => {
    const { launch, createWorktree, settle } = await refuseAcceptedChat(false)
    settle('failed')
    await vi.waitFor(() => expect(lifecycleOf(launch.sessionId)).toBe('failed'))
    // Kept: the failure settled while no tab showed it.
    expect(savedLaunch(launch.sessionId)).toMatchObject({ lifecycle: 'failed' })

    const reads = mocks.hostLaunch.mock.calls.length
    retryBackgroundWorktreeCreation('creation-1')
    await vi.waitFor(() => expect(chatTabs(launch.sessionId)).toHaveLength(1))
    // Showing it reads that same launch again, which is still failed.
    await vi.waitFor(() => expect(lifecycleOf(launch.sessionId)).toBe('failed'))
    expect(mocks.hostLaunch.mock.calls.slice(reads)).toEqual([
      ['agent.launchStatus', expect.objectContaining({ operationId: launch.operationId })]
    ])
    expect(sessionDraft(launch.sessionId)).toContain(HELD)
    expect(sessionDraft(launch.sessionId)).toContain(FOLLOW_UP)
    expectNothingStartedTwice(createWorktree)
  })

  it.each([
    ['foreground', 'succeeded', true],
    ['foreground', 'failed', true],
    ['foreground', 'unknown', true],
    ['background', 'succeeded', false],
    ['background', 'failed', false],
    ['background', 'unknown', false]
  ] as const)(
    'comes back after a reload with no saved tab (%s), and a recheck reads the same launch: %s',
    async (_focus, answer, foreground) => {
      const { launch, createWorktree } = await refuseAcceptedChat(foreground)
      reloadWindow()
      expect(savedLaunch(launch.sessionId)).toMatchObject({ lifecycle: 'pending' })

      restoreStructuredLaunchSurfaces()
      await main.settle()
      expect(chatTabs(launch.sessionId)).toHaveLength(1)
      expect(useAppStore.getState().activeWorktreeId).toBe('previous-worktree')
      expect(lifecycleOf(launch.sessionId)).toBe('visibility-unknown')
      expect(sessionDraft(launch.sessionId)).toBe(FOLLOW_UP)

      hostReplies(async () => hostAnswer(answer, launch.sessionId))
      expect(retryStructuredAgentSessionLaunch(worktree.id, launch.sessionId)).toBe(true)
      if (answer === 'succeeded') {
        // Adopted: the chat shows and has the message, so nothing is left to recover.
        await vi.waitFor(() => expect(lifecycleOf(launch.sessionId)).toBeNull())
        expect(savedLaunch(launch.sessionId)).toBeUndefined()
        expect(sessionDraft(launch.sessionId)).toBe(FOLLOW_UP)
      } else {
        await vi.waitFor(() =>
          expect(lifecycleOf(launch.sessionId)).toBe(
            answer === 'failed' ? 'failed' : 'visibility-unknown'
          )
        )
        expect(sessionDraft(launch.sessionId)).toContain(HELD)
        expect(sessionDraft(launch.sessionId)).toContain(FOLLOW_UP)
        expect(savedLaunch(launch.sessionId)).toBeDefined()
      }
      expectNothingStartedTwice(createWorktree)
    }
  )

  it.each(['failed', 'succeeded'] as const)(
    'keeps a launch the host settled (%s) before the layout refused its chat, through a reload',
    async (answer) => {
      const { launch, createWorktree } = await refuseAcceptedChat(false, answer)
      expect(savedLaunch(launch.sessionId)).toMatchObject({
        lifecycle: answer === 'failed' ? 'failed' : 'visibility-unknown'
      })
      reloadWindow()
      restoreStructuredLaunchSurfaces()
      await main.settle()
      expect(chatTabs(launch.sessionId)).toHaveLength(1)
      if (answer === 'failed') {
        expect(lifecycleOf(launch.sessionId)).toBe('failed')
        expect(sessionDraft(launch.sessionId)).toContain(HELD)
        hostReplies(async () => hostAnswer(answer, launch.sessionId))
        await expectRetryRereadsOnly(launch.sessionId, launch.operationId)
        expect(savedLaunch(launch.sessionId)).toMatchObject({
          hostLaunchOperationId: launch.operationId,
          lifecycle: 'failed'
        })
      } else {
        hostReplies(async () => hostAnswer(answer, launch.sessionId))
        expect(retryStructuredAgentSessionLaunch(worktree.id, launch.sessionId)).toBe(true)
        await vi.waitFor(() => expect(lifecycleOf(launch.sessionId)).toBeNull())
        expect(savedLaunch(launch.sessionId)).toBeUndefined()
      }
      expect(sessionDraft(launch.sessionId)).toContain(FOLLOW_UP)
      expectNothingStartedTwice(createWorktree)
    }
  )

  it('ends the launch and its draft on Dismiss, leaving nothing for a reload', async () => {
    const { launch } = await refuseAcceptedChat(false)
    const entry = useAppStore.getState().pendingWorktreeCreations['creation-1']
    closeDismissedHostLaunch(entry)
    useAppStore.getState().removePendingWorktreeCreation('creation-1')

    expect(savedLaunch(launch.sessionId)).toBeUndefined()
    expect(sessionDraft(launch.sessionId)).toBe('')
    reloadWindow()
    restoreStructuredLaunchSurfaces()
    await main.settle()
    expect(chatTabs(launch.sessionId)).toEqual([])
    expect(lifecycleOf(launch.sessionId)).toBeNull()
  })
})
