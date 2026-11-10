import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../shared/native-chat/native-chat-types'
import { emitNativeChatMessageSent } from '../components/native-chat/telemetry/native-chat-telemetry'
import { track } from '../diagnostics/telemetry/telemetry'
import { launchPromptAsMessage } from '../components/native-chat/session/terminal/delivery/native-chat-pending'

vi.mock('../diagnostics/telemetry/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: () => 'codex'
}))

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

const earlier: NativeChatMessage = {
  id: 'earlier-user-message',
  role: 'user',
  blocks: [{ type: 'text', text: 'Initial request' }],
  timestamp: 1,
  source: 'transcript'
}

const followUps = () =>
  vi.mocked(track).mock.calls.filter(([name]) => name === 'native_chat_follow_up_sent')

it('counts delivered follow-ups without counting first sends, commands or failed attempts', async () => {
  const emit = (priorMessages: NativeChatMessage[], submission = Promise.resolve(true)) =>
    emitNativeChatMessageSent({
      agent: 'codex',
      runtime: 'remote',
      followUp: { priorMessages, submission, submissionHistory: new Map() }
    })
  emit([])
  emit([
    { ...earlier, role: 'assistant' },
    { ...earlier, agentId: 'child-agent' },
    { ...earlier, from: { kind: 'agent', senders: [], orchestration: null } },
    { ...earlier, command: { name: 'compact' } },
    { ...earlier, unsent: true },
    { ...earlier, pendingSend: 'active' },
    { ...earlier, deliveryState: 'unknown' },
    { ...earlier, awaitsRetry: true },
    { ...earlier, stoppedBeforeStart: true },
    { ...earlier, sentWhileStopping: true },
    { ...earlier, agentStart: true }
  ])
  emit([earlier], Promise.resolve(false))
  emit([earlier], Promise.reject(new Error('delivery failed')))
  const submission = Promise.withResolvers<boolean>()
  emit([earlier], submission.promise)
  expect(followUps()).toEqual([])
  submission.resolve(true)
  await vi.waitFor(() =>
    expect(followUps()).toEqual([
      ['native_chat_follow_up_sent', { agent_kind: 'codex', runtime: 'remote', client: 'desktop' }]
    ])
  )
})

it('waits for a pending predecessor to succeed even when the follow-up settles first', async () => {
  const submissionHistory = new Map<string, Promise<boolean>>()
  const predecessor = Promise.withResolvers<boolean>()
  emitNativeChatMessageSent({
    agent: 'codex',
    runtime: 'local',
    followUp: {
      priorMessages: [],
      submission: predecessor.promise,
      messageId: earlier.id,
      submissionHistory
    }
  })
  emitNativeChatMessageSent({
    agent: 'codex',
    runtime: 'local',
    followUp: {
      priorMessages: [{ ...earlier, pendingSend: 'queued', deliveryState: 'pending' }],
      submission: Promise.resolve(true),
      messageId: 'follow-up',
      submissionHistory
    }
  })
  await Promise.resolve()
  expect(followUps()).toEqual([])
  predecessor.resolve(true)
  await vi.waitFor(() =>
    expect(followUps()).toEqual([
      ['native_chat_follow_up_sent', { agent_kind: 'codex', runtime: 'local', client: 'desktop' }]
    ])
  )
})

it('does not count a delivered second send when its pending predecessor fails', async () => {
  const submissionHistory = new Map<string, Promise<boolean>>()
  const predecessor = Promise.withResolvers<boolean>()
  emitNativeChatMessageSent({
    agent: 'codex',
    runtime: 'local',
    followUp: {
      priorMessages: [],
      submission: predecessor.promise,
      messageId: earlier.id,
      submissionHistory
    }
  })
  emitNativeChatMessageSent({
    agent: 'codex',
    runtime: 'local',
    followUp: {
      priorMessages: [{ ...earlier, deliveryState: 'pending' }],
      submission: Promise.resolve(true),
      submissionHistory
    }
  })
  predecessor.resolve(false)
  // A later confirmed queued message can still establish a follow-up.
  emitNativeChatMessageSent({
    agent: 'codex',
    runtime: 'local',
    followUp: {
      priorMessages: [{ ...earlier, id: 'host-queued', queued: true }],
      submission: Promise.resolve(true),
      submissionHistory
    }
  })
  await vi.waitFor(() =>
    expect(followUps()).toEqual([
      ['native_chat_follow_up_sent', { agent_kind: 'codex', runtime: 'local', client: 'desktop' }]
    ])
  )
})

it('keeps successful submission evidence after its row leaves the loaded history', async () => {
  const submissionHistory = new Map<string, Promise<boolean>>()
  emitNativeChatMessageSent({
    agent: 'codex',
    runtime: 'local',
    followUp: { priorMessages: [], submission: Promise.resolve(true), submissionHistory }
  })
  await Promise.resolve()
  emitNativeChatMessageSent({
    agent: 'codex',
    runtime: 'local',
    followUp: { priorMessages: [], submission: Promise.resolve(true), submissionHistory }
  })
  await vi.waitFor(() =>
    expect(followUps()).toEqual([
      ['native_chat_follow_up_sent', { agent_kind: 'codex', runtime: 'local', client: 'desktop' }]
    ])
  )
})

it('does not treat a failed synthetic launch prompt as a successful predecessor', async () => {
  vi.useFakeTimers()
  const launch = launchPromptAsMessage({
    tabId: 'failed-launch',
    agent: 'codex',
    text: 'Initial request',
    createdAt: 1,
    failed: true
  })!
  emitNativeChatMessageSent({
    agent: 'codex',
    runtime: 'local',
    followUp: {
      priorMessages: [launch],
      submission: Promise.resolve(true),
      submissionHistory: new Map()
    }
  })
  await vi.runAllTimersAsync()
  expect(followUps()).toEqual([])
})

it('counts a delivered follow-up using older evidence while another delivery remains unknown', async () => {
  const unknown = Promise.withResolvers<boolean>()
  emitNativeChatMessageSent({
    agent: 'codex',
    runtime: 'local',
    followUp: {
      priorMessages: [],
      submission: Promise.resolve(true),
      priorSubmission: async () => true,
      submissionHistory: new Map([['unknown-delivery', unknown.promise]])
    }
  })
  await vi.waitFor(() =>
    expect(followUps()).toEqual([
      ['native_chat_follow_up_sent', { agent_kind: 'codex', runtime: 'local', client: 'desktop' }]
    ])
  )
})
