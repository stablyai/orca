// @vitest-environment happy-dom
import {
  fixture,
  transport,
  WORKSPACE,
  TAB,
  SUBJECT,
  REMOTE_TARGET,
  ReadSurface,
  AttentionPolicy,
  readCalls
} from './structured-attention-read-retirement.test-fixture'
import { Fragment, createElement } from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from '../../src/main/native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage
} from '../../src/main/native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../src/shared/agent-session-journal-item-key'
import { agentSessionFailureWords } from '../../src/shared/agent-session-failure-words'
import { readAgentJournalTurn } from '../../src/shared/agent-session-turn-record'
import { structuredAgentSessionCommandTurn } from '../../src/shared/structured-agent-session-command-turn-identity'
import type { AgentSessionCommandAdmission } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AgentSessionHistoryPage } from '../../src/shared/agent-session-wire'
import type { RuntimeRpcResponse } from '../../src/shared/runtime-rpc-envelope'
import { registerSubjectRetirement } from '../../src/main/ipc/notifications-subject-retirement.test-fixture'
import {
  getDismissHandler,
  getDispatchHandler,
  notificationIsSupportedMock,
  resetNotificationDispatchMocks
} from '../../src/main/ipc/notifications-test-harness'
import { makeUnifiedTab } from '@/store/slices/store-test-helpers'
import { useAppStore } from '@/store'
import { StructuredAgentSessionAttentionBridge } from '@/components/native-chat/StructuredAgentSessionAttentionBridge'
import { getStructuredAgentSessionReadOwner } from '@/components/native-chat/structured-agent-session-read-owner'

vi.mock('electron', async () =>
  (await import('../../src/main/ipc/notifications-test-harness')).createElectronModuleMock()
)
vi.mock('../../src/main/ipc/notification-authorization-status', async () =>
  (
    await import('../../src/main/ipc/notifications-test-harness')
  ).createNotificationAuthorizationModuleMock()
)
vi.mock('../../src/main/ipc/ui', async () =>
  (
    await import('../../src/main/ipc/notifications-test-harness')
  ).createTrustedUIRendererModuleMock()
)
vi.mock('../../src/main/tray/system-tray', async () =>
  (await import('../../src/main/ipc/notifications-test-harness')).createSystemTrayModuleMock()
)

it('keeps an actual unread delivery through pending, refused and accepted compact, then retires it on genuine work', async () => {
  const h = hostTestState()
  let resolveAdmission: (value: AgentSessionCommandAdmission) => void = () => {}
  const admission = new Promise<AgentSessionCommandAdmission>((resolve) => {
    resolveAdmission = resolve
  })
  const compact = vi
    .fn<NonNullable<typeof h.host.deps.adapter.compact>>()
    .mockImplementationOnce(() => admission)
    .mockResolvedValue({ state: 'accepted', providerIdentity: null })
  Object.assign(h.host.deps.adapter, { compact })
  await attach()
  const journal = h.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  resetNotificationDispatchMocks()
  registerSubjectRetirement({ suppressWhenFocused: false }, fixture.controller)
  notificationIsSupportedMock.mockReturnValue(false)
  transport.dispatch.mockImplementation(async (request) => getDispatchHandler()({}, request))
  transport.dismiss.mockImplementation(async (...args) => getDismissHandler()({}, ...args))
  vi.mocked(document.hasFocus).mockReturnValue(false)
  Object.assign(window.api, { worktrees: { updateMeta: vi.fn().mockResolvedValue(undefined) } })
  const tab = makeUnifiedTab({
    id: TAB,
    worktreeId: WORKSPACE,
    groupId: 'group',
    contentType: 'agent-session',
    entityId: SESSION,
    agentSessionAgent: 'codex',
    executionHostId: 'runtime:relay-host'
  })
  useAppStore.setState({ unifiedTabsByWorktree: { [WORKSPACE]: [tab] } })
  let older: AgentSessionHistoryPage | undefined
  transport.call.mockImplementation(async (_target, method: string, params: unknown) => {
    if (method === 'agentSession.history') {
      const request = z
        .object({
          sessionId: z.string(),
          direction: z.enum(['tail', 'before', 'after']),
          cursor: z.object({ epoch: z.string(), sequence: z.number() }).optional(),
          limit: z.number().optional()
        })
        .parse(params)
      return older && request.direction === 'before'
        ? { ok: true, page: older }
        : h.host.history(request)
    }
    if (method === 'agentSession.currentRequests') {
      return h.host.readCurrentRequests(
        z
          .object({
            sessionId: z.string(),
            version: z.string(),
            cursor: z.number().optional()
          })
          .parse(params)
      )
    }
    throw new Error(`Unexpected RPC: ${method}`)
  })
  let publication = 0
  let historyEmit: ((response: RuntimeRpcResponse<unknown>) => void) | undefined
  const subscriptions = new Set<() => void>()
  const subscribe = async (
    request: { method: string; params?: unknown },
    emit: (response: RuntimeRpcResponse<unknown>) => void
  ) => {
    const reply = (result: unknown) =>
      emit({
        id: 'real-host',
        ok: true,
        _meta: { runtimeId: 'attention-host' },
        result
      })
    let stop: () => void
    if (request.method === 'agentSession.subscribe') {
      historyEmit = emit
      const input = z
        .object({
          sessionId: z.string(),
          cursor: z.object({ epoch: z.string(), sequence: z.number() }).optional()
        })
        .parse(request.params)
      stop = await h.host.subscribe({ id: 'command-reader', ...input, emit: reply })
    } else if (request.method === 'agentSession.subscribeTurnCompletions') {
      stop = h.host.subscribeTurnCompletions({
        id: 'command-edges',
        includePrompts: true,
        emit: reply
      })
    } else if (request.method === 'agentSession.subscribeStatus') {
      stop = h.host.subscribeStatus({ id: 'command-status', emit: reply })
    } else {
      throw new Error(`Unexpected subscription: ${request.method}`)
    }
    publication += 1
    subscriptions.add(stop)
    return {
      unsubscribe: () => {
        subscriptions.delete(stop)
        stop()
      }
    }
  }
  Object.assign(window.api.runtimeEnvironments, {
    subscribe: (
      request: { method: string; params?: unknown },
      callbacks: {
        onResponse: (response: RuntimeRpcResponse<unknown>) => void
      }
    ) => subscribe(request, callbacks.onResponse)
  })
  const owner = getStructuredAgentSessionReadOwner(SESSION, REMOTE_TARGET)
  const screen = render(
    createElement(
      Fragment,
      null,
      createElement(ReadSurface, { viewed: true, target: REMOTE_TARGET }),
      createElement(AttentionPolicy),
      createElement(StructuredAgentSessionAttentionBridge)
    )
  )
  const notifications = () => fixture.events.filter((event) => event.type === 'notification')
  const dismissals = () => fixture.events.filter((event) => event.type === 'dismiss')
  const send = async (text: string) => {
    const body = hostTestMessage(text)
    const command = envelope('agentSession.send', { body })
    expect(await h.host.send(CALLER, { envelope: command, body })).toMatchObject({ ok: true })
    await vi.waitFor(() =>
      expect(journal.submission(command.clientOperationId)?.dispatchState).toBe('accepted')
    )
    return command.clientOperationId
  }
  const write = async (turnId: string, operation: string, state: 'running' | 'completed') => {
    const identity = { provider: 'codex' as const, threadId: THREAD, turnId, ordinal: 0 }
    h.acquire.mock.calls.at(-1)![0].events!.appendItem(
      identity,
      {
        kind: 'turn',
        turnId,
        state,
        userItemId: agentJournalSubmissionKey(operation),
        ...(state === 'completed' ? { outcome: 'success' as const } : {})
      },
      { turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(identity) } }
    )
    await h.host.flushStreamedEvents(SESSION)
    await waitFor(() =>
      expect(
        owner
          .getSnapshot()
          .state.items.find((item) => item.itemId === agentJournalItemKey(identity))?.body
      ).toMatchObject({ state })
    )
  }
  const command = async () => {
    const params = {
      command: 'compact' as const,
      envelope: envelope('agentSession.conversationCommand', { command: 'compact' })
    }
    expect(await h.host.conversationCommand(CALLER, params)).toMatchObject({ ok: true })
    return params.envelope.clientOperationId
  }
  const retainedCommand = (operation: string) =>
    owner
      .getSnapshot()
      .state.items.find(
        (item) => item.itemId === structuredAgentSessionCommandTurn(operation).itemId
      )
  const retainUnread = () => {
    expect(readCalls()).toBe(0)
    expect(useAppStore.getState().unreadAgentCompletionPanes[SUBJECT]).toBe('agent-completion')
    expect(dismissals()).toEqual([])
  }
  try {
    await waitFor(() => expect(publication).toBe(3))
    await waitFor(() => expect(owner.getSnapshot().current).toBe(true))
    const first = await send('Original request')
    await write('first', first, 'running')
    await write('first', first, 'completed')
    await waitFor(() => expect(notifications()).toHaveLength(1))
    const original = notifications()[0]!
    expect(original).toMatchObject({
      executionHost: 'runtime:relay-host',
      notificationEpoch: expect.any(String),
      notificationSeq: expect.any(Number)
    })
    fixture.controller.dispatch({
      type: 'notification',
      source: 'test',
      title: '',
      body: '',
      notificationId: 'unrelated',
      executionHost: 'runtime:elsewhere'
    })
    retainUnread()
    const refused = await command()
    await waitFor(() => expect(compact).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(readAgentJournalTurn(retainedCommand(refused)?.body)?.state).toBe('running')
    )
    const running = retainedCommand(refused)!
    const named = readAgentJournalTurn(running.body)!.userItemId!
    const body = owner.getSnapshot().state.items.find((item) => item.itemId === named)!
    expect(body).toBeDefined()
    expect(body.sequence).toBeLessThan(running.sequence)
    expect(journal.item(running.itemId)).toMatchObject({
      revision: running.revision,
      sequence: running.sequence
    })
    expect(owner.getSnapshot().current).toBe(true)
    expect(original.structuredOrigin?.journalCursor).toBeDefined()
    expect(running.sequence).toBeGreaterThan(original.structuredOrigin!.journalCursor.sequence)
    retainUnread()
    resolveAdmission({
      state: 'rejected',
      ...agentSessionFailureWords({ kind: 'providerRejected' }, { surface: 'rejection' })
    })
    await waitFor(() =>
      expect(readAgentJournalTurn(retainedCommand(refused)?.body)).toMatchObject({
        state: 'completed',
        outcome: 'failure'
      })
    )
    retainUnread()
    const accepted = await command()
    await waitFor(() => expect(compact).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(readAgentJournalTurn(retainedCommand(accepted)?.body)?.state).toBe('running')
    )
    retainUnread()
    const acceptedRun = compact.mock.calls[1]![0].command
    h.acquire.mock.calls.at(-1)![0].events!.appendLifecycleBatch!(
      'accepted-compact-end',
      [
        {
          kind: 'item',
          identity: acceptedRun.identity,
          body: { ...acceptedRun.running, state: 'completed', outcome: 'success' },
          turnScope: { kind: 'thread' }
        }
      ],
      { lifecycle: true }
    )
    await h.host.flushStreamedEvents(SESSION)
    await waitFor(() =>
      expect(readAgentJournalTurn(retainedCommand(accepted)?.body)).toMatchObject({
        state: 'completed',
        outcome: 'success'
      })
    )
    retainUnread()
    const history = await h.host.history({ sessionId: SESSION, direction: 'tail' })
    if (!history.ok || !historyEmit) {
      throw new Error('Actual command history not available')
    }
    expect(body.body).toMatchObject({ kind: 'message', role: 'user', command: { name: 'compact' } })
    const incomplete = {
      ...history.page,
      items: [running],
      submissions: [],
      hasOlder: true,
      window: {
        oldest: { epoch: history.page.epoch, sequence: running.sequence },
        newest: { epoch: history.page.epoch, sequence: running.sequence },
        nextCursor: { epoch: history.page.epoch, sequence: running.sequence }
      }
    }
    await act(async () =>
      historyEmit!({
        id: 'retained-suffix',
        ok: true,
        _meta: { runtimeId: 'attention-host' },
        result: {
          type: 'snapshot',
          sessionId: SESSION,
          page: incomplete,
          fence: history.page.fence ?? 1
        }
      })
    )
    expect(owner.getSnapshot()).toMatchObject({
      current: true,
      state: { epoch: history.page.epoch }
    })
    expect(owner.getSnapshot().state.items).toEqual([running])
    retainUnread()
    older = {
      ...history.page,
      direction: 'before',
      items: [body],
      submissions: [],
      hasOlder: false,
      hasNewer: true,
      window: {
        oldest: { epoch: history.page.epoch, sequence: body.sequence },
        newest: { epoch: history.page.epoch, sequence: body.sequence },
        nextCursor: { epoch: history.page.epoch, sequence: body.sequence }
      }
    }
    await act(async () => {
      expect(await owner.loadOlder()).toBe('applied')
    })
    expect(
      owner.getSnapshot().state.items.find((item) => item.itemId === running.itemId)?.sequence
    ).toBe(running.sequence)
    expect(owner.getSnapshot().state.items.find((item) => item.itemId === named)).toEqual(body)
    retainUnread()
    expect(
      await h.host.conversationCommand(CALLER, {
        command: 'clear',
        envelope: envelope('agentSession.conversationCommand', { command: 'clear' })
      })
    ).toMatchObject({ ok: true })
    await waitFor(() =>
      expect(
        owner
          .getSnapshot()
          .state.items.some((item) => item.body.kind === 'status' && item.body.contextClear)
      ).toBe(true)
    )
    expect(
      owner.getSnapshot().state.items.find((item) => item.itemId === running.itemId)?.sequence
    ).toBe(running.sequence)
    retainUnread()
    const later = await send('Genuine later request')
    await write('later', later, 'running')
    await waitFor(() => expect(dismissals()).toHaveLength(1))
    expect(dismissals()[0]).toMatchObject({
      notificationId: original.notificationId,
      dismissedDelivery: {
        notificationId: original.notificationId,
        notificationEpoch: original.notificationEpoch,
        notificationSeq: original.notificationSeq
      }
    })
    expect(transport.dismiss.mock.calls.filter((call) => call[3]?.length)).toEqual([
      [
        [],
        [],
        undefined,
        [{ notificationId: original.notificationId, executionHost: 'runtime:relay-host' }]
      ]
    ])
    expect(notifications().map((event) => event.notificationId)).toEqual([
      original.notificationId,
      'unrelated'
    ])
    expect(dismissals().some((event) => event.notificationId === 'unrelated')).toBe(false)
    expect(readCalls()).toBe(0)
    await fixture.controller.flushDismissals()
    expect(
      fixture.controller.reconcileDismissedPushes([
        {
          notificationId: original.notificationId!,
          notificationEpoch: original.notificationEpoch!,
          notificationSeq: original.notificationSeq!
        }
      ])
    ).toHaveLength(1)
  } finally {
    resolveAdmission({ state: 'unknown', reason: 'fixture cleanup' })
    screen.unmount()
    for (const stop of subscriptions) {
      stop()
    }
  }
})
