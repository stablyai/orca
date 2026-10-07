// @vitest-environment happy-dom
// Register preload/store seams before importing their consumers.
import {
  fixture,
  REMOTE_TARGET,
  NOTIFICATION_SETTINGS,
  transport,
  WORKSPACE,
  TAB,
  addPrompt,
  publishStatus,
  publishView,
  ReadSurface,
  AttentionPolicy,
  readCalls
} from './structured-attention-read-retirement.test-fixture'
import { Fragment, createElement } from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import { join } from 'node:path'
import type { NotificationDispatchRequest } from '../../src/shared/notification-settings-types'
import type { AgentJournalRenderItem } from '../../src/shared/agent-session-journal-types'
import type { AgentSessionExecutionLocation } from '../../src/shared/agent-session-record'
import { RuntimeMobileNotificationController } from '../../src/main/runtime/runtime-mobile-notification-controller'
import { MobileNotificationDismissalStore } from '../../src/main/runtime/mobile-notification-dismissal-store'
import { createNotificationDeliveryService } from '../../src/main/notifications/notification-delivery-service'
import { SESSION } from '../../src/main/runtime/rpc/methods/structured-agent-session-rpc.test-fixture'
import { makeUnifiedTab, makeWorktree } from '@/store/slices/store-test-helpers'
import { useAppStore } from '@/store'
import { StructuredAgentSessionAttentionBridge } from '@/components/native-chat/StructuredAgentSessionAttentionBridge'

/** A remote-host chat this desktop relays to its own phones while the user is away. */
async function mountRemoteRelay(options?: { promptStatus?: false; raise?: false }) {
  const relayDirectory = join(fixture.directory, 'relay')
  const relay = new RuntimeMobileNotificationController()
  relay.configureDismissalStore(relayDirectory)
  const delivery = createNotificationDeliveryService({
    readNotificationSettings: () => NOTIFICATION_SETTINGS,
    findActiveWindow: () => null,
    isWindowVisible: () => false,
    setTrayAttention: () => {},
    isNotificationSupported: () => false,
    dispatchMobileNotification: relay.dispatch.bind(relay),
    readAuthorizationStatus: async () => 'authorized',
    recordDeliveryOutcome: () => {},
    deliverNative: () => ({ delivered: true }),
    platform: 'linux',
    now: () => 20_000
  })
  transport.dispatch.mockImplementation(async (request: NotificationDispatchRequest) =>
    delivery.dispatch(request)
  )
  // What the notifications:settleStructuredPrompts handler does with it.
  transport.settle.mockImplementation(async (scope: AgentSessionExecutionLocation, id: string) =>
    relay.reconcileStructuredPromptAttention({ scope, sessionId: id, pendingPromptIds: [] })
  )
  transport.away.mockResolvedValue(true)
  useAppStore.setState({
    activeWorktreeId: 'elsewhere',
    activeWorkspaceExecutionHostId: 'runtime:relay-host',
    worktreesByRepo: {
      repo1: [
        makeWorktree({
          id: WORKSPACE,
          repoId: 'repo1',
          hostId: 'runtime:relay-host',
          runtimeOwnerEnvironmentId: 'relay-host'
        })
      ]
    },
    unifiedTabsByWorktree: {
      [WORKSPACE]: [
        makeUnifiedTab({
          id: TAB,
          worktreeId: WORKSPACE,
          groupId: 'group',
          contentType: 'agent-session',
          entityId: SESSION,
          agentSessionAgent: 'claude',
          executionHostId: 'runtime:relay-host'
        })
      ]
    },
    runtimeEnvironments: [
      {
        id: 'relay-host',
        name: 'Remote',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: null,
        endpoints: [],
        preferredEndpointId: 'endpoint'
      }
    ]
  })
  render(
    createElement(
      Fragment,
      null,
      createElement(StructuredAgentSessionAttentionBridge),
      createElement(AttentionPolicy),
      createElement(ReadSurface, { viewed: false, target: REMOTE_TARGET })
    )
  )
  await waitFor(() => expect(fixture.completion).toBeTypeOf('function'))
  await waitFor(() => expect(fixture.status).toBeTypeOf('function'))
  act(() => publishStatus())
  const live = (kind: 'prompt' | 'completion') =>
    new MobileNotificationDismissalStore(relayDirectory)
      .liveDeliveries()
      .filter((entry) => entry.structuredOrigin?.cause.kind === kind)
  if (options?.raise === false) {
    return { live }
  }
  act(() => {
    addPrompt('A')
    if (options?.promptStatus !== false) {
      publishStatus()
    }
    publishView()
  })
  await waitFor(() => expect(live('prompt')).toHaveLength(1))
  return { live }
}

function revise(update: (item: AgentJournalRenderItem) => AgentJournalRenderItem): void {
  fixture.sequence += 1
  fixture.items = fixture.items.map((item) => {
    const next = update(item)
    return next === item
      ? item
      : { ...next, revision: item.revision + 1, sequence: fixture.sequence }
  })
}

const resolvePrompt =
  (id: string, state: 'resolved' | 'cancelled') =>
  (item: AgentJournalRenderItem): AgentJournalRenderItem =>
    item.itemId === id && item.body.kind === 'approval'
      ? {
          ...item,
          body: {
            ...item.body,
            resolution: {
              state,
              selectedOptionId: state === 'resolved' ? 'yes' : null,
              resolvedBy: state === 'resolved' ? 'second-client' : null,
              resolvedAt: fixture.sequence
            }
          }
        }
      : item

const resolveA = (state: 'resolved' | 'cancelled') => resolvePrompt('A', state)

const interrupt = (item: AgentJournalRenderItem): AgentJournalRenderItem =>
  item.body.kind === 'turn'
    ? { ...item, body: { ...item.body, state: 'interrupted', outcome: 'cancellation' } }
    : item

/** A frame the status socket queued before A's commit: another session's row. */
function otherSessionStatus(): void {
  fixture.status?.({
    id: 'status',
    ok: true,
    _meta: { runtimeId: 'h' },
    result: {
      type: 'status',
      session: {
        sessionId: 'other-session',
        workspaceId: WORKSPACE,
        agent: 'claude',
        status: 'working',
        latestPrompt: '',
        updatedAt: 1
      }
    }
  })
}

function endStatusStream(): void {
  fixture.status?.({ id: 'status', ok: true, _meta: { runtimeId: 'h' }, result: { type: 'end' } })
}

it.each([
  ['answered from another client', () => revise(resolveA('resolved'))],
  ['turn cancelled', () => revise((item) => interrupt(resolveA('cancelled')(item)))]
] as const)(
  'withdraws the relayed prompt alert once the remote host reports none pending: %s',
  async (_mode, resolve) => {
    const relay = await mountRemoteRelay()
    act(() => {
      resolve()
      fixture.hostFeed.observe(SESSION)
      publishStatus()
    })
    await waitFor(() => expect(relay.live('prompt')).toEqual([]))
    expect(readCalls()).toBe(0)
    expect(transport.settle).toHaveBeenCalledOnce()
    // Prompt settlement never touches a completion alert.
    const relayedCompletions = transport.dispatch.mock.calls.filter(
      ([request]: [NotificationDispatchRequest]) =>
        request.structuredOrigin?.cause.kind === 'completion'
    )
    expect(relay.live('completion')).toHaveLength(relayedCompletions.length)
  }
)

it('withdraws it when a restarted remote host comes back with the prompt cancelled', async () => {
  const relay = await mountRemoteRelay()
  const before = fixture.status
  act(() => endStatusStream())
  revise((item) => interrupt(resolveA('cancelled')(item)))
  await waitFor(() => expect(fixture.status).not.toBe(before))
  act(() => publishStatus())
  await waitFor(() => expect(relay.live('prompt')).toEqual([]))
})

it('keeps the relayed prompt alert while the host still reports a prompt pending', async () => {
  const relay = await mountRemoteRelay()
  act(() => {
    revise((item) => item)
    publishStatus()
  })
  await act(async () => {})
  expect(transport.settle).not.toHaveBeenCalled()
  expect(relay.live('prompt')).toHaveLength(1)
})

it('never settles from a status the desktop lost contact with', async () => {
  // The mirror still holds the row from before A, which reads no prompt; it goes unverifiable.
  const relay = await mountRemoteRelay({ promptStatus: false })
  act(() => endStatusStream())
  await act(async () => {})
  expect(transport.settle).not.toHaveBeenCalled()
  expect(relay.live('prompt')).toHaveLength(1)
})

it('settles once per relayed prompt, not on every later status update', async () => {
  await mountRemoteRelay()
  act(() => {
    revise(resolveA('resolved'))
    fixture.hostFeed.observe(SESSION)
    publishStatus()
  })
  await waitFor(() => expect(transport.settle).toHaveBeenCalledOnce())
  act(() => {
    revise((item) => item)
    publishStatus()
  })
  await act(async () => {})
  expect(transport.settle).toHaveBeenCalledOnce()
})

// Status and edges ride separate sockets: the pre-prompt row can still be draining after the edge.
it('keeps the pending prompt alert when the edge outruns its status and another frame lands', async () => {
  const relay = await mountRemoteRelay({ promptStatus: false })
  act(() => otherSessionStatus())
  await act(async () => {})
  act(() => publishStatus())
  await act(async () => {})
  expect(transport.settle).not.toHaveBeenCalled()
  expect(relay.live('prompt')).toHaveLength(1)
})

it('keeps it when a queued frame lands in the same task as the edge', async () => {
  const relay = await mountRemoteRelay({ promptStatus: false })
  act(() => {
    addPrompt('B')
    otherSessionStatus()
  })
  await act(async () => {})
  expect(transport.settle).not.toHaveBeenCalled()
  expect(relay.live('prompt')).toHaveLength(2)
})

it('retries a settlement that failed on the next qualifying row', async () => {
  const relay = await mountRemoteRelay()
  const settle = transport.settle.getMockImplementation()
  transport.settle.mockRejectedValueOnce(new Error('main unavailable'))
  act(() => {
    revise(resolveA('resolved'))
    fixture.hostFeed.observe(SESSION)
    publishStatus()
  })
  await waitFor(() => expect(transport.settle).toHaveBeenCalledOnce())
  expect(relay.live('prompt')).toHaveLength(1)
  transport.settle.mockImplementation(settle ?? (async () => {}))
  act(() => {
    revise((item) => item)
    publishStatus()
  })
  await waitFor(() => expect(relay.live('prompt')).toEqual([]))
  expect(transport.settle).toHaveBeenCalledTimes(2)
})

it('settles a prompt answered while the previous settle call was still out', async () => {
  const relay = await mountRemoteRelay()
  const reconcile = transport.settle.getMockImplementation()
  const replies: (() => void)[] = []
  // Main reconciles on arrival; only the reply is late.
  transport.settle.mockImplementation((scope: AgentSessionExecutionLocation, id: string) => {
    void reconcile?.(scope, id)
    return new Promise<void>((resolve) => replies.push(resolve))
  })
  act(() => {
    revise(resolveA('resolved'))
    fixture.hostFeed.observe(SESSION)
    publishStatus()
  })
  await waitFor(() => expect(replies).toHaveLength(1))
  act(() => {
    addPrompt('B')
    publishStatus()
  })
  await waitFor(() => expect(relay.live('prompt')).toHaveLength(1))
  act(() => {
    revise(resolvePrompt('B', 'resolved'))
    fixture.hostFeed.observe(SESSION)
    publishStatus()
  })
  await act(async () => {})
  expect(replies).toHaveLength(1)
  // The host goes quiet; the reply alone must re-judge the mirror.
  await act(async () => replies[0]?.())
  await waitFor(() => expect(relay.live('prompt')).toEqual([]))
})

it('settles a prompt whose edge arrives after its own resolution row', async () => {
  const relay = await mountRemoteRelay({ raise: false })
  const deliver = fixture.completion
  const held: Parameters<NonNullable<typeof deliver>>[0][] = []
  fixture.completion = (response) => held.push(response)
  act(() => {
    addPrompt('A')
    publishStatus()
    revise(resolveA('resolved'))
    fixture.hostFeed.observe(SESSION)
    publishStatus()
  })
  fixture.completion = deliver
  act(() => held.forEach((response) => deliver?.(response)))
  await waitFor(() =>
    expect(
      transport.dispatch.mock.calls.some(
        ([request]: [NotificationDispatchRequest]) =>
          request.structuredOrigin?.cause.kind === 'prompt'
      )
    ).toBe(true)
  )
  await waitFor(() => expect(relay.live('prompt')).toEqual([]))
  expect(transport.settle).toHaveBeenCalledOnce()
})
