// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mocks,
  resetCreateMessageFixture,
  cleanupCreateMessageFixture,
  deferred,
  draft
} from '../../structured-agent-session-launch-create-message.test-fixture'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  retryStructuredAgentSessionLaunch,
  startStructuredAgentLaunch
} from './structured-agent-session-launch'
import {
  getStructuredAgentSessionLaunchFailure,
  getStructuredAgentSessionLaunchLifecycle,
  resetStructuredAgentLaunchRegistryForTests
} from './structured-agent-session-launch-registry'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
import { resetStructuredAgentSessionSendsForTests } from '@/components/native-chat/structured-agent-session-message-sender'
import { newAgentLaunchRequestId } from '../../agent-launch-request-id'
import { getStructuredAgentSessionSendNotice } from '@/components/native-chat/structured-agent-session-pending-sends'
import { structuredSessionNotices } from '@/components/native-chat/native-chat-structured-session-notices'
import { requiredSetupLaunchFailureText } from '@/lib/required-setup-launch-failure'
import { updateNativeChatComposerDraft } from '@/components/native-chat/native-chat-composer-draft-store'
import type { AgentLaunchStatusResult } from '../../../../../shared/rpc-contract/agent-launch-accept-params'
import type { AgentLaunchResult } from '../../../../../shared/agent-launch-intent'
import type { AgentSessionHistoryPage } from '../../../../../shared/agent-session/agent-session-wire'
import { structuredAgentSessionSendBody } from '../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'

const OPERATION_ID = `${Date.now()}-000000000000000000000000000000ac`
const SESSION_ID = 'codex_9b1deb4d_3b7d_4bad_9bdd_2b0d7b3dcb6d'
const HELD = 'Inspect the failing test and fix it'
const SOURCE_SCOPE = 'pending-worktree-creation:creation-1'
/** The host founded the reserved chat with the first message as its own. */
const CHAT_STARTED: AgentLaunchStatusResult = {
  state: 'succeeded',
  result: {
    outcome: { kind: 'structured', sessionId: SESSION_ID, handle: 'chat' },
    worktreeId: 'workspace-1',
    receipt: { mode: 'structured', preferred: 'structured', reason: 'user_default', detail: '' },
    prompt: { delivery: 'submit', outcome: 'journaled', messageId: 'host-message' }
  } satisfies AgentLaunchResult
}

const host = vi.hoisted(() => ({
  accept: vi.fn<(params: unknown) => Promise<unknown>>(),
  status: vi.fn<(params: unknown, options: unknown) => Promise<AgentLaunchStatusResult>>()
}))

function hostAnswers(): void {
  vi.mocked(callRuntimeRpc).mockImplementation(async (_target, method, params, options) =>
    method === 'agent.launchAccept'
      ? host.accept(params)
      : method === 'agent.launchStatus'
        ? host.status(params, options)
        : {}
  )
}

const MESSAGE_ID = `${Date.now()}-000000000000000000000000000000ae`

function startHostLaunch(accept = true) {
  return startStructuredAgentLaunch('workspace-1', 'codex', {
    requestId: newAgentLaunchRequestId(),
    executionHostId: 'local',
    prompt: HELD,
    draftFromScope: SOURCE_SCOPE,
    hostLaunch: {
      operationId: OPERATION_ID,
      sessionId: SESSION_ID,
      firstMessage: { clientMessageId: MESSAGE_ID, body: structuredAgentSessionSendBody(HELD, []) },
      ...(accept
        ? {
            accept: {
              prompt: { text: HELD, clientMessageId: MESSAGE_ID },
              presentation: 'focused' as const,
              setupReceipt: { required: true as const, runId: 'setup-run-1' }
            }
          }
        : {})
    }
  })
}

/** Everything the window asked its host: never a chat create or send of its own. */
function windowCalls(): string[] {
  return [
    ...vi.mocked(callRuntimeRpc).mock.calls.map(([, method]) => method),
    ...mocks.call.mock.calls.map(([, method]) => method)
  ].filter((method) => method !== 'session.tabs.close')
}

/** The chat's tail as the host has it once the first message is journaled. */
function hostHistory() {
  const cursor = { epoch: 'epoch-1', sequence: 1 }
  const page: AgentSessionHistoryPage = {
    sessionId: SESSION_ID,
    epoch: cursor.epoch,
    fence: 3,
    direction: 'tail',
    items: [],
    removedItemIds: [],
    submissions: [],
    window: { oldest: null, newest: null, nextCursor: cursor },
    liveCursor: cursor,
    hasOlder: false,
    hasNewer: false,
    latestTurn: null
  }
  return { ok: true, page }
}

const lifecycle = () => getStructuredAgentSessionLaunchLifecycle('workspace-1', SESSION_ID)

let restore: (() => void) | undefined
beforeEach(() => {
  restore = resetCreateMessageFixture()
  hostAnswers()
  host.accept.mockResolvedValue({ operationId: OPERATION_ID, state: 'running' })
  updateNativeChatComposerDraft(SOURCE_SCOPE, { text: 'Also run lint', images: [] }, 'immediate')
})
afterEach(() => cleanupCreateMessageFixture(restore))

describe('a chat its host launches after the workspace’s Setup', () => {
  it('adopts the host’s chat for the same session without sending its first message again', async () => {
    const status = deferred<AgentLaunchStatusResult>()
    host.status.mockResolvedValueOnce({ state: 'running' }).mockReturnValueOnce(status.promise)
    mocks.call.mockResolvedValue(hostHistory())
    const launch = startHostLaunch()
    expect(launch.sessionId).toBe(SESSION_ID)

    await vi.waitFor(() => expect(host.status).toHaveBeenCalledTimes(2))
    expect(lifecycle()).toBe('pending')
    expect(host.accept).toHaveBeenCalledOnce()
    expect(host.accept.mock.calls[0]![0]).toMatchObject({
      operationId: OPERATION_ID,
      sessionId: SESSION_ID,
      target: { kind: 'existing' },
      nativeChatDefault: true,
      presentation: 'focused',
      // The chat founds the message under this window's own id, behind the creation's Setup run.
      prompt: { text: HELD, delivery: 'submit', clientMessageId: MESSAGE_ID },
      setupReceipt: { required: true, runId: 'setup-run-1' }
    })
    expect(host.accept.mock.calls[0]![0]).not.toHaveProperty('surface')
    // Each read is an ordinary bounded request.
    expect(host.status.mock.calls[0]).toEqual([
      { operationId: OPERATION_ID, waitMs: 20_000 },
      { timeoutMs: 25_000 }
    ])
    expect(windowCalls()).toEqual([
      'agent.launchAccept',
      'agent.launchStatus',
      'agent.launchStatus'
    ])

    status.resolve(CHAT_STARTED)
    await expect(launch.launchResult).resolves.toMatchObject({ sessionId: SESSION_ID, fence: 3 })
    await vi.waitFor(() => expect(lifecycle()).toBeNull())
    expect(windowCalls()).not.toContain('agentSession.create')
    expect(windowCalls()).not.toContain('agentSession.send')
    // The unsent draft moved into the chat; the first message is the host's, never handed back.
    expect(draft(SESSION_ID)).toBe('Also run lint')
  })

  it.each([
    ['Setup did not succeed', 'agent_launch_setup_not_completed', true],
    ['the chat was closed first', 'agent_launch_tab_closed', false]
  ])(
    'keeps the first message when %s, and starts nothing else',
    async (_case, code, explainsSetup) => {
      const status = deferred<AgentLaunchStatusResult>()
      host.status.mockReturnValue(status.promise)
      startHostLaunch()
      await vi.waitFor(() => expect(host.status).toHaveBeenCalledOnce())
      // A Setup past the send's own deadline is no reason to doubt the launch or hand text back.
      await vi.advanceTimersByTimeAsync(31_000)
      expect(lifecycle()).toBe('pending')
      expect(getStructuredAgentSessionSendNotice(SESSION_ID)).toBeNull()

      status.resolve({ state: 'failed', code })
      await vi.waitFor(() => expect(lifecycle()).toBe('failed'))
      expect(draft(SESSION_ID)).toContain(HELD)
      expect(draft(SESSION_ID)).toContain('Also run lint')
      expect(windowCalls()).toEqual(['agent.launchAccept', 'agent.launchStatus'])
      const notices = structuredSessionNotices({
        launch: {
          lifecycle: 'failed',
          failure: getStructuredAgentSessionLaunchFailure('workspace-1', SESSION_ID),
          retry: () => {}
        },
        agentLabel: 'Codex',
        sessionError: null,
        composerError: null
      })
      expect(notices.map((notice) => notice.text)).toEqual([
        explainsSetup ? requiredSetupLaunchFailureText('Codex') : 'Chat could not be started.'
      ])
    }
  )

  it.each(['a reload', 'a lost status reply'])(
    'reads the same launch again after %s and never accepts it twice',
    async (loss) => {
      if (loss === 'a reload') {
        host.status.mockReturnValueOnce(new Promise(() => undefined))
        startHostLaunch()
        await vi.waitFor(() => expect(host.status).toHaveBeenCalledOnce())
        resetStructuredAgentLaunchRegistryForTests()
        resetStructuredAgentLaunchPersistenceForTests()
        expect(lifecycle()).toBe('visibility-unknown')
      } else {
        host.status.mockRejectedValue(new Error('runtime_unavailable'))
        startHostLaunch()
        await vi.advanceTimersByTimeAsync(5_000)
        await vi.waitFor(() => expect(lifecycle()).toBe('visibility-unknown'))
      }
      host.status.mockReset()
      host.status.mockResolvedValue(CHAT_STARTED)
      mocks.call.mockResolvedValue(hostHistory())

      expect(retryStructuredAgentSessionLaunch('workspace-1', SESSION_ID)).toBe(true)
      await vi.waitFor(() => expect(lifecycle()).toBeNull())
      expect(host.accept).toHaveBeenCalledOnce()
      expect(host.status).toHaveBeenCalledWith(
        { operationId: OPERATION_ID, waitMs: 20_000 },
        { timeoutMs: 25_000 }
      )
      expect(windowCalls()).not.toContain('agentSession.create')
      if (loss === 'a reload') {
        // The host's chat holds the message, so no copy comes back.
        expect(draft(SESSION_ID)).not.toContain(HELD)
      }
    }
  )

  it.each([
    ['fails', { state: 'failed', code: 'agent_launch_setup_not_completed' }],
    ['cannot be confirmed', { state: 'unknown' }]
  ] as const)(
    'gives the held message back when, after a reload, the same launch %s, and sends nothing',
    async (_case, answer) => {
      host.status.mockReturnValueOnce(new Promise(() => undefined))
      startHostLaunch()
      await vi.waitFor(() => expect(host.status).toHaveBeenCalledOnce())
      // Saved beside the launch before the host answered, under the id the host was given.
      expect(localStorage.getItem('orca:structuredAgentLaunches:v1')).toContain(MESSAGE_ID)
      resetStructuredAgentLaunchRegistryForTests()
      resetStructuredAgentLaunchPersistenceForTests()
      resetStructuredAgentSessionSendsForTests()
      host.status.mockReset()
      host.status.mockResolvedValue(answer)

      expect(retryStructuredAgentSessionLaunch('workspace-1', SESSION_ID)).toBe(true)
      await vi.waitFor(() =>
        expect(lifecycle()).toBe(answer.state === 'failed' ? 'failed' : 'visibility-unknown')
      )
      expect(draft(SESSION_ID)).toContain(HELD)
      expect(draft(SESSION_ID)).toContain('Also run lint')
      expect(host.accept).toHaveBeenCalledOnce()
      expect(windowCalls()).not.toContain('agentSession.create')
      expect(windowCalls()).not.toContain('agentSession.send')
      // Given back once: the saved copy is gone, so another reload has nothing to repeat.
      expect(localStorage.getItem('orca:structuredAgentLaunches:v1') ?? '').not.toContain(
        MESSAGE_ID
      )
    }
  )
})

describe('the held message of a launch the host ran in a terminal', () => {
  const terminalStarted = (prompt: AgentLaunchResult['prompt']): AgentLaunchStatusResult => ({
    state: 'succeeded',
    result: {
      outcome: { kind: 'terminal', handle: 'term_1' },
      worktreeId: 'workspace-1',
      receipt: {
        mode: 'terminal',
        preferred: 'structured',
        reason: 'structured_unsupported_on_host',
        detail: ''
      },
      ...(prompt ? { prompt } : {})
    }
  })

  it.each([
    ['its submit was not delivered', { delivery: 'submit', outcome: 'not-delivered' }, true],
    ['it was left unsent there', { delivery: 'draft', outcome: 'not-delivered' }, true],
    ['its delivery is unconfirmed', { delivery: 'submit', outcome: 'unconfirmed' }, true],
    ['it was handed to the terminal', { delivery: 'submit', outcome: 'handed-to-terminal' }, false]
  ] as const)('is %s: back in the composer only without a receipt', async (_c, prompt, kept) => {
    host.status.mockResolvedValue(terminalStarted(prompt))
    const launch = startHostLaunch()
    await expect(launch.launchResult).rejects.toMatchObject({
      name: 'StructuredHostLaunchTerminalError'
    })
    if (kept) {
      await expect(launch.promptDeliveryResult).resolves.toMatchObject({ delivered: false })
      expect(draft(SESSION_ID)).toContain(HELD)
    } else {
      expect(draft(SESSION_ID)).not.toContain(HELD)
    }
    expect(draft(SESSION_ID)).toContain('Also run lint')
    expect(windowCalls()).not.toContain('agentSession.send')
  })
})
