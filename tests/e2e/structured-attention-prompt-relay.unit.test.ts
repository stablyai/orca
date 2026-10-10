// @vitest-environment happy-dom
// Register preload/store seams before importing their consumers.
import {
  fixture,
  REMOTE_TARGET,
  NOTIFICATION_SETTINGS,
  transport,
  WORKSPACE,
  TAB,
  SUBJECT,
  SCOPE,
  addPrompt,
  publishView,
  ReadSurface,
  AttentionPolicy,
  readCalls,
  dismissIds
} from './structured-attention-read-retirement.test-fixture'
import { Fragment, createElement } from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import { join } from 'node:path'
import type {
  NotificationDispatchRequest,
  StructuredNotificationRead
} from '../../src/shared/notification-settings-types'
import type { AgentJournalRenderItem } from '../../src/shared/agent-session-journal-types'
import {
  agentSessionPromptAttentionKey,
  agentSessionAttentionSubjectPrefix,
  type AgentSessionAttentionEdge
} from '../../src/shared/agent-session-attention'
import {
  RuntimeMobileNotificationController,
  type MobileNotificationEvent
} from '../../src/main/runtime/runtime-mobile-notification-controller'
import { MobileNotificationDismissalStore } from '../../src/main/runtime/mobile-notification-dismissal-store'
import { createNotificationDeliveryService } from '../../src/main/notifications/notification-delivery-service'
import { SESSION } from '../../src/main/runtime/rpc/methods/structured-agent-session-rpc.test-fixture'
import { makeUnifiedTab, makeWorktree } from '@/store/slices/store-test-helpers'
import { captureAgentSubjectReads } from '@/attention/agent-subject-read-actions'
import { useAppStore } from '@/store'
import { StructuredAgentSessionAttentionBridge } from '@/components/native-chat/StructuredAgentSessionAttentionBridge'

async function mountPausedRelay({ viewed = true, away = false } = {}) {
  const relayDirectory = join(fixture.directory, 'relay')
  const relay = new RuntimeMobileNotificationController()
  relay.configureDismissalStore(relayDirectory)
  const relayEvents: MobileNotificationEvent[] = []
  relay.onDispatched((event) => relayEvents.push(event))
  const delivery = createNotificationDeliveryService({
    readNotificationSettings: () => NOTIFICATION_SETTINGS,
    findActiveWindow: () => null,
    isWindowVisible: () => true,
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
  transport.dismiss.mockImplementation(
    async (_ids, _panes, reads?: StructuredNotificationRead[]) => {
      for (const read of reads ?? []) {
        relay.retireStructuredAttention(read)
      }
      return { dismissed: 0 }
    }
  )
  transport.away.mockResolvedValue(away)
  useAppStore.setState({
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
      createElement(ReadSurface, { viewed: viewed, target: REMOTE_TARGET })
    )
  )
  await waitFor(() => expect(fixture.hydrate).toBeTypeOf('function'))
  await act(async () => fixture.hydrate?.())
  await waitFor(() => expect(fixture.journal).toBeTypeOf('function'))
  const attention = fixture.completion
  if (!attention) {
    throw new Error('attention transport not subscribed')
  }
  const edges: AgentSessionAttentionEdge[] = []
  fixture.hostFeed.subscribe({
    id: 'paused-relay',
    includePrompts: true,
    emit: (edge) => {
      if (edge.type !== 'end') {
        edges.push(edge)
      }
    }
  })
  fixture.completion = undefined
  return {
    relayEvents,
    edges,
    release: (edge = edges.at(-1)) => {
      if (!edge) {
        throw new Error('host did not commit attention')
      }
      attention({
        id: 'completion',
        ok: true,
        _meta: { runtimeId: 'attention-host' },
        result: edge
      })
    },
    liveDeliveries: () => new MobileNotificationDismissalStore(relayDirectory).liveDeliveries()
  }
}

it.each(['visible', 'read then away', 'tab/store rerender', 'failed retirement'] as const)(
  'a read prompt creates no delayed relay notification or withdrawal: %s',
  async (mode) => {
    const relay = await mountPausedRelay()
    if (mode === 'failed retirement') {
      const original = transport.call.getMockImplementation()
      transport.call.mockImplementation(async (...args) => {
        if (args[1] === 'agentSession.acknowledgeAttention') {
          throw new Error('scripted host retirement failure')
        }
        return original?.(...args)
      })
    }
    const priorReads = readCalls()
    act(() => {
      addPrompt('A')
      publishView()
    })
    await waitFor(() => expect(readCalls()).toBeGreaterThan(priorReads))
    await act(async () => {})
    expect(dismissIds()).toHaveLength(mode === 'failed retirement' ? 0 : 1)
    expect(relay.edges.at(-1)).toMatchObject({
      type: 'prompt',
      prompt: { promptId: 'A', journalCursor: { epoch: 'journal-a', sequence: 3 } }
    })
    if (mode === 'read then away' || mode === 'tab/store rerender') {
      transport.away.mockResolvedValue(true)
      act(() => useAppStore.setState({ activeWorktreeId: 'elsewhere' }))
    }
    if (mode === 'tab/store rerender') {
      act(() =>
        useAppStore.setState((state) => ({
          settings: state.settings ? { ...state.settings } : null,
          unifiedTabsByWorktree: {
            ...state.unifiedTabsByWorktree,
            [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE].map((tab) => ({
              ...tab,
              label: 'Renamed chat'
            }))
          }
        }))
      )
    }
    await act(async () => relay.release())
    expect(transport.dispatch).not.toHaveBeenCalled()
    expect(relay.relayEvents).toEqual([])
    expect(relay.liveDeliveries()).toEqual([])
    expect(useAppStore.getState().unreadAgentCompletionPanes[SUBJECT]).toBeUndefined()
  }
)

it('reading A does not cover unseen B on the same remote subject', async () => {
  const relay = await mountPausedRelay()
  act(() => {
    addPrompt('A')
    publishView()
  })
  await waitFor(() => expect(dismissIds()).toHaveLength(1))
  transport.away.mockResolvedValue(true)
  act(() => {
    useAppStore.setState({ activeWorktreeId: 'elsewhere' })
    addPrompt('B')
  })
  const [a, b] = relay.edges
  await act(async () => {
    relay.release(a)
    relay.release(b)
  })
  expect(relay.relayEvents).toMatchObject([
    { type: 'notification', notificationId: agentSessionPromptAttentionKey(SCOPE, SESSION, 'B') }
  ])
  expect(relay.liveDeliveries()).toHaveLength(1)
  expect(useAppStore.getState().unreadAgentCompletionPanes[SUBJECT]).toBe('agent-completion')
})

it('captured read cursors are cloned and a late older read cannot lower their frontier', async () => {
  const relay = await mountPausedRelay({ away: true })
  const olderRead = captureAgentSubjectReads([SUBJECT])
  act(() => {
    addPrompt('A')
    publishView()
  })
  await act(async () => {})
  const currentRead = captureAgentSubjectReads([SUBJECT])
  expect(currentRead[0].structured?.observedCursor).toEqual({ epoch: 'journal-a', sequence: 3 })
  await act(async () => useAppStore.getState().acknowledgeAgents([SUBJECT], currentRead))
  const structured = currentRead[0].structured
  if (!structured) {
    throw new Error('accepted read owner not captured')
  }
  structured.observedCursor.sequence = 0
  await act(async () => useAppStore.getState().acknowledgeAgents([SUBJECT], olderRead))
  await act(async () => relay.release())
  expect(relay.relayEvents).toEqual([])
  act(() => addPrompt('B'))
  await act(async () => relay.release())
  expect(relay.relayEvents).toMatchObject([
    { type: 'notification', notificationId: agentSessionPromptAttentionKey(SCOPE, SESSION, 'B') }
  ])
})

it('accepting a transcript while away does not fabricate a read frontier', async () => {
  const relay = await mountPausedRelay({ away: true })
  act(() => {
    addPrompt('A')
    publishView()
  })
  await act(async () => {})
  expect(readCalls()).toBe(0)
  expect(dismissIds()).toEqual([])
  await act(async () => relay.release())
  expect(relay.relayEvents).toMatchObject([{ type: 'notification' }])
  expect(relay.liveDeliveries()).toHaveLength(1)
})

it('a genuine read during unread writes prevents the final relay delivery', async () => {
  const relay = await mountPausedRelay({ viewed: false, away: true })
  act(() => {
    useAppStore.setState({ activeWorktreeId: 'elsewhere' })
    addPrompt('A')
    publishView()
  })
  expect(readCalls()).toBe(0)
  let readDuringUnread = false
  const stop = useAppStore.subscribe((state) => {
    if (!readDuringUnread && state.unreadAgentCompletionPanes[SUBJECT]) {
      readDuringUnread = true
      state.acknowledgeAgents([SUBJECT])
    }
  })
  try {
    await act(async () => relay.release())
    expect(readDuringUnread).toBe(true)
    await waitFor(() => expect(dismissIds()).toHaveLength(1))
    expect(relay.relayEvents).toEqual([])
    expect(relay.liveDeliveries()).toEqual([])
  } finally {
    stop()
  }
})

it.each(['missing cursor', 'different epoch', 'different target'] as const)(
  'read coverage never spends unproven prompt identity: %s',
  async (mode) => {
    const relay = await mountPausedRelay()
    act(() => {
      addPrompt('A')
      publishView()
    })
    await waitFor(() => expect(dismissIds()).toHaveLength(1))
    transport.away.mockResolvedValue(true)
    act(() => useAppStore.setState({ activeWorktreeId: 'elsewhere' }))
    const edge = relay.edges.at(-1)
    if (edge?.type !== 'prompt') {
      throw new Error('expected actual prompt frame')
    }
    if (mode === 'different target') {
      act(() =>
        useAppStore.setState((state) => ({
          unifiedTabsByWorktree: {
            [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE].map((tab) => ({
              ...tab,
              executionHostId: 'runtime:another-host'
            }))
          }
        }))
      )
      await waitFor(() => expect(fixture.completion).toBeTypeOf('function'))
      await act(async () =>
        fixture.completion?.({
          id: 'rebound',
          ok: true,
          _meta: { runtimeId: 'attention-host' },
          result: edge
        })
      )
    } else {
      const { journalCursor, ...oldPrompt } = edge.prompt
      expect(journalCursor).toEqual({ epoch: 'journal-a', sequence: 3 })
      await act(async () =>
        relay.release({
          type: 'prompt',
          prompt: {
            ...oldPrompt,
            ...(mode === 'different epoch'
              ? { journalCursor: { epoch: 'journal-b', sequence: 3 } }
              : {})
          }
        })
      )
    }
    expect(relay.relayEvents).toMatchObject([{ type: 'notification' }])
    expect(relay.liveDeliveries()).toHaveLength(1)
  }
)

it.each(['success', 'failure'] as const)(
  'prompt read coverage leaves independent %s completion delivery unchanged',
  async (outcome) => {
    const relay = await mountPausedRelay()
    act(() => {
      addPrompt('A')
      publishView()
    })
    await waitFor(() => expect(dismissIds()).toHaveLength(1))
    act(() => {
      fixture.items = fixture.items.map((item): AgentJournalRenderItem => {
        if (item.body.kind === 'turn') {
          return {
            ...item,
            revision: item.revision + 1,
            body: { ...item.body, state: 'completed', outcome }
          }
        }
        if (outcome === 'success' && item.body.kind === 'approval') {
          return {
            ...item,
            revision: item.revision + 1,
            body: { ...item.body, resolution: { ...item.body.resolution, state: 'resolved' } }
          }
        }
        return item
      })
      fixture.sequence += 1
      fixture.hostFeed.observe(SESSION)
      publishView()
    })
    await act(async () => {})
    expect(relay.edges.at(-1)).toMatchObject({ type: 'completion', completion: { outcome } })
    await act(async () => relay.release())
    expect(relay.relayEvents).toMatchObject([
      {
        type: 'notification',
        notificationId: `${agentSessionAttentionSubjectPrefix(SCOPE, SESSION)}turn:turn-1`
      }
    ])
    expect(relay.liveDeliveries()).toHaveLength(1)
  }
)
