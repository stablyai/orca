import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../src/shared/agent-session-journal-types'
import { agentSessionPromptAttentionKey } from '../../src/shared/agent-session-attention'
import { projectStructuredAgentSessionStatusState } from '../../src/shared/structured-agent-session-projection'
import { AGENT_SESSION_ATTENTION_ACK_RUNTIME_CAPABILITY } from '../../src/shared/protocol-version'
import { StructuredAgentSessionTurnCompletionFeed } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-turn-completion-feed'
import {
  RuntimeMobileNotificationController,
  type MobileNotificationEvent
} from '../../src/main/runtime/runtime-mobile-notification-controller'
import { createStructuredAttentionMobileDelivery } from '../../src/main/runtime/structured-agent-session-mobile-attention'
import {
  createHarness,
  flush,
  registration
} from '../../src/main/runtime/push/push-dispatcher.test-fixture'
import {
  call,
  installStructuredHostStub,
  clearStructuredHostStub,
  STRUCTURED_CLIENT,
  SESSION
} from '../../src/main/runtime/rpc/methods/structured-agent-session-rpc.test-fixture'

const transport = vi.hoisted(() => ({ call: vi.fn(), supports: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: transport.call,
  runtimeEnvironmentSupportsCapability: transport.supports
}))
import { acknowledgeStructuredAgentSessionAttention } from '../../src/renderer/src/runtime/structured-agent-session-client'

const SCOPE = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'folder-1',
  workspaceKind: 'folder'
} as const
function prompt(id: string, sequence: number): AgentJournalRenderItem {
  return {
    itemId: id,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: {
      kind: 'approval',
      title: 'Allow?',
      detail: null,
      options: [{ id: 'yes', label: 'Allow' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }
  }
}
function attentionPath(directory: string) {
  const controller = new RuntimeMobileNotificationController()
  controller.configureDismissalStore(directory)
  const events: MobileNotificationEvent[] = []
  controller.onDispatched((event) => events.push(event))
  let items: AgentJournalRenderItem[] = [
    {
      itemId: 'user',
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Work' }] }
    },
    {
      itemId: 'turn',
      revision: 1,
      sequence: 2,
      observedAt: 2,
      body: { kind: 'turn', turnId: 'turn-1', state: 'running' }
    }
  ]
  let sequence = 2
  const delivery = createStructuredAttentionMobileDelivery({
    readNotificationSettings: () => ({
      enabled: true,
      agentTaskComplete: true,
      terminalBell: true,
      suppressWhenFocused: false,
      customSoundId: 'system',
      customSoundPath: null,
      customSoundVolume: 1,
      mutedNotificationSourceIds: []
    }),
    readWorkspaceLabels: () => ({}),
    dispatch: (event) => controller.dispatch(event),
    reconcile: (state) => controller.reconcileStructuredPromptAttention(state),
    now: () => 42
  })
  const feed = new StructuredAgentSessionTurnCompletionFeed({
    sessions: new Map([
      [
        SESSION,
        {
          journal: { cursor: () => ({ epoch: 'journal-a', sequence }) },
          params: { location: SCOPE }
        }
      ]
    ]),
    readStatusState: () => projectStructuredAgentSessionStatusState(items),
    now: () => 42
  })
  feed.subscribe({
    id: 'mobile',
    includePrompts: true,
    onState: delivery.reconcile,
    emit: (event) => {
      if (event.type !== 'end') {
        delivery.deliver(event, undefined)
      }
    }
  })
  feed.observe(SESSION)
  return {
    controller,
    events,
    add: (id: string) => {
      items = [...items, prompt(id, ++sequence)]
      feed.observe(SESSION)
      return { epoch: 'journal-a', sequence }
    }
  }
}
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-bounded-read-'))
  installStructuredHostStub()
  vi.clearAllMocks()
})
afterEach(() => {
  clearStructuredHostStub()
  rmSync(directory, { recursive: true, force: true })
})

it('a delayed production renderer read retires A while leaving unseen B live', async () => {
  const h = attentionPath(directory)
  const cursor = h.add('A')
  let release = (): void => {}
  transport.supports.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        release = () => resolve(true)
      })
  )
  transport.call.mockImplementation(async (_target, method: string, params: unknown) => {
    const reply = await call(method, params, STRUCTURED_CLIENT, {
      retireStructuredAttention: h.controller.retireStructuredAttention.bind(h.controller)
    })
    if (!reply.ok) {
      throw new Error(reply.error.message)
    }
    return reply.result
  })
  const read = acknowledgeStructuredAgentSessionAttention(
    { kind: 'environment', environmentId: 'host-a' },
    SESSION,
    cursor
  )
  h.add('B')
  cursor.sequence = 200
  release()
  await expect(read).resolves.toBe(true)
  expect(transport.supports).toHaveBeenCalledWith(
    'host-a',
    AGENT_SESSION_ATTENTION_ACK_RUNTIME_CAPABILITY
  )
  expect(
    h.events.filter((event) => event.type === 'dismiss').map((event) => event.notificationId)
  ).toEqual([agentSessionPromptAttentionKey(SCOPE, SESSION, 'A')])
  const delivered = h.events
    .filter((event) => event.type === 'notification')
    .flatMap((event) =>
      event.notificationId && event.notificationEpoch && event.notificationSeq !== undefined
        ? [
            {
              notificationId: event.notificationId,
              notificationEpoch: event.notificationEpoch,
              notificationSeq: event.notificationSeq
            }
          ]
        : []
    )
  expect(h.controller.reconcileDismissedPushes(delivered)).toEqual(delivered.slice(0, 1))
})

it('keeps missing-origin and other-journal deliveries outside a bounded read', () => {
  const h = attentionPath(directory)
  const read = h.add('A')
  h.controller.dispatch({
    type: 'notification',
    source: 'agent-task-complete',
    title: 'Legacy',
    body: '',
    notificationId: agentSessionPromptAttentionKey(SCOPE, SESSION, 'old')
  })
  h.controller.retireStructuredAttention({
    sessionId: SESSION,
    observedCursor: { ...read, epoch: 'later-journal' }
  })
  expect(h.events.filter((event) => event.type === 'dismiss')).toEqual([])
  h.controller.retireStructuredAttention({ sessionId: SESSION, observedCursor: read })
  expect(h.events.filter((event) => event.type === 'dismiss')).toHaveLength(1)
})

it('a restart sends the original delivery fence in the existing native gateway fields', async () => {
  const h = attentionPath(directory)
  const cursor = h.add('A')
  const original = h.events.find((event) => event.type === 'notification')
  if (!original) {
    throw new Error('prompt not delivered')
  }
  const restarted = new RuntimeMobileNotificationController()
  restarted.configureDismissalStore(directory)
  const gateway = createHarness({
    devices: [{ deviceId: 'phone', pushRegistration: registration() }]
  })
  const retirement: MobileNotificationEvent[] = []
  restarted.onDispatched((event) => {
    retirement.push(event)
    gateway.dispatcher.enqueue(event)
  })
  restarted.retireStructuredAttention({ sessionId: SESSION, observedCursor: cursor })
  await flush()
  expect(retirement).toEqual([
    expect.objectContaining({
      notificationEpoch: restarted.getEpoch(),
      notificationSeq: 1,
      dismissedDelivery: {
        notificationId: original.notificationId,
        notificationEpoch: original.notificationEpoch,
        notificationSeq: original.notificationSeq
      }
    })
  ])
  expect(restarted.getEpoch()).not.toBe(original.notificationEpoch)
  expect(gateway.sends).toHaveLength(1)
  expect(gateway.sends[0]?.notification).toMatchObject({
    kind: 'dismiss',
    notificationId: original.notificationId,
    notificationEpoch: original.notificationEpoch,
    notificationSeq: original.notificationSeq
  })
})

it('skips a host that supports only the old session-wide acknowledgement', async () => {
  transport.supports.mockResolvedValue(false)
  await expect(
    acknowledgeStructuredAgentSessionAttention(
      { kind: 'environment', environmentId: 'old-host' },
      SESSION,
      { epoch: 'a', sequence: 1 }
    )
  ).resolves.toBe(false)
  expect(transport.call).not.toHaveBeenCalled()
})
