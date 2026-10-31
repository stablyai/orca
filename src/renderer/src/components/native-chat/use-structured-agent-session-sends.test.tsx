// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { resetStructuredAgentSessionSendsForTests } from './structured-agent-session-message-sender'
import { useStructuredAgentSessionSends } from './use-structured-agent-session-sends'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { AGENT_SESSION_STEER_DRAFT_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-runtime-capabilities'
import { getStructuredAgentSessionPendingSends } from './structured-agent-session-pending-sends'

const QUEUEING = {
  capability: 'supported',
  followUpsQueue: true,
  isWorking: true,
  stopping: false,
  session: { queuedMessages: [] },
  prompts: []
} as const

afterEach(() => {
  resetStructuredAgentSessionSendsForTests()
  setLocalRuntimeCapabilitiesForTests(null)
  mocks.call.mockClear()
})

it.each([
  ['a text follow-up while the agent works', QUEUEING, true, [], 'queued'],
  ['the same follow-up when the agent is idle', QUEUEING, false, [], true],
  ['with the queue setting off', { ...QUEUEING, followUpsQueue: false }, true, [], true],
  [
    'an image follow-up, which queues like text',
    QUEUEING,
    true,
    [{ path: '/a.png', previewUri: '/a.png' }],
    'queued'
  ]
] as const)(
  'answers whether %s waits as a queued card',
  (_case, queue, isWorking, images, admission) => {
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_STEER_DRAFT_RUNTIME_CAPABILITY])
    mocks.call.mockImplementation(() => new Promise(() => {}))
    const { result } = renderHook(() =>
      useStructuredAgentSessionSends({
        sessionId: 'session-1',
        target: { kind: 'local' },
        fence: 1,
        submissions: [],
        queuedMessageIds: [],
        queue: { ...queue, isWorking },
        historyLoaded: false,
        isWorking
      })
    )
    let sent: boolean | 'queued' = false
    act(() => {
      sent = result.current.send('follow up', images)
    })
    expect(sent).toBe(admission)
  }
)

it('takes no second send while the first is out', () => {
  mocks.call.mockImplementation(() => new Promise(() => {}))
  const { result } = renderHook(() =>
    useStructuredAgentSessionSends({
      sessionId: 'session-1',
      target: { kind: 'local' },
      fence: 1,
      submissions: [],
      queuedMessageIds: [],
      queue: QUEUEING,
      historyLoaded: false,
      isWorking: true
    })
  )
  let first: boolean | 'queued' = false
  let second: boolean | 'queued' = true
  act(() => {
    first = result.current.send('one')
    second = result.current.send('two')
  })
  expect(first).toBe('queued')
  expect(second).toBe(false)
})

it('carries explicit steer intent and the complete image draft once over transport', async () => {
  setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_STEER_DRAFT_RUNTIME_CAPABILITY])
  mocks.call.mockImplementation(() => new Promise(() => {}))
  const options = { model: 'model-next', effort: 'high', fastMode: 'true' }
  const { result } = renderHook(() =>
    useStructuredAgentSessionSends({
      sessionId: 'session-steer',
      target: { kind: 'local' },
      fence: 1,
      submissions: [],
      queuedMessageIds: [],
      queue: QUEUEING,
      historyLoaded: false,
      isWorking: true,
      sendOptions: () => options
    })
  )
  const images = [{ path: '/host/image.png', previewUri: 'blob:preview' }]
  act(() => {
    expect(result.current.send('inspect this image', images, { delivery: 'immediate' })).toBe(true)
    expect(result.current.send('inspect this image', images, { delivery: 'immediate' })).toBe(false)
  })
  await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
  expect(mocks.call.mock.calls[0]?.slice(0, 2)).toEqual([{ kind: 'local' }, 'agentSession.send'])
  expect(mocks.call.mock.calls[0]?.[2]).toMatchObject({
    steer: true,
    options,
    body: {
      blocks: [
        { type: 'text', text: 'inspect this image' },
        { type: 'image-ref', path: '/host/image.png' }
      ]
    }
  })
  expect(mocks.call.mock.calls[0]?.[2]).not.toHaveProperty('delivery')
})

it('queues an explicit alternate send with images even when Enter sends immediately', async () => {
  mocks.call.mockImplementation(() => new Promise(() => {}))
  const { result } = renderHook(() =>
    useStructuredAgentSessionSends({
      sessionId: 'session-alternate-queue',
      target: { kind: 'local' },
      fence: 1,
      submissions: [],
      queuedMessageIds: [],
      queue: { ...QUEUEING, followUpsQueue: false },
      historyLoaded: false,
      isWorking: true,
      sendOptions: () => ({ model: 'future-model', effort: 'low' })
    })
  )
  act(() => {
    expect(
      result.current.send('Later', [{ path: '/host/later.png', previewUri: '' }], {
        delivery: 'queue-if-active'
      })
    ).toBe('queued')
  })
  await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
  expect(mocks.call.mock.calls[0]?.[2]).toMatchObject({
    delivery: 'queue-if-active',
    options: { model: 'future-model', effort: 'low' },
    body: {
      blocks: [
        { type: 'text', text: 'Later' },
        { type: 'image-ref', path: '/host/later.png' }
      ]
    }
  })
  expect(mocks.call.mock.calls[0]?.[2]).not.toHaveProperty('steer')
})

it('uses current-turn steering for the default immediate Enter action on a capable host', async () => {
  setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_STEER_DRAFT_RUNTIME_CAPABILITY])
  mocks.call.mockImplementation(() => new Promise(() => {}))
  const { result } = renderHook(() =>
    useStructuredAgentSessionSends({
      sessionId: 'session-enter-immediate',
      target: { kind: 'local' },
      fence: 1,
      submissions: [],
      queuedMessageIds: [],
      queue: { ...QUEUEING, followUpsQueue: false },
      historyLoaded: false,
      isWorking: true
    })
  )
  act(() => expect(result.current.send('Correction')).toBe(true))
  await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
  expect(mocks.call.mock.calls[0]?.[2]).toHaveProperty('steer', true)
  expect(mocks.call.mock.calls[0]?.[2]).not.toHaveProperty('delivery')
})

it('keeps accepted options and images through a composer remount while future picks change', async () => {
  mocks.call.mockImplementation(() => new Promise(() => {}))
  const options = { model: 'model-a', effort: 'high', fastMode: 'false' }
  const input = {
    sessionId: 'session-remount',
    target: { kind: 'local' as const },
    fence: 1,
    submissions: [],
    queuedMessageIds: [],
    queue: QUEUEING,
    historyLoaded: false,
    isWorking: true,
    sendOptions: () => options
  }
  const first = renderHook(() => useStructuredAgentSessionSends(input))
  act(() => {
    first.result.current.send('queued image', [{ path: '/host/a.png', previewUri: 'blob:a' }])
  })
  options.model = 'model-b'
  options.fastMode = 'true'
  first.unmount()
  const remounted = renderHook(() => useStructuredAgentSessionSends(input))
  expect(remounted.result.current.pending).toHaveLength(1)
  expect(getStructuredAgentSessionPendingSends('session-remount')[0]).toMatchObject({
    options: { model: 'model-a', effort: 'high', fastMode: 'false' },
    body: {
      blocks: [
        { type: 'text', text: 'queued image' },
        { type: 'image-ref', path: '/host/a.png' }
      ]
    },
    previewUris: ['blob:a']
  })
  await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
})

it.each(['unknown', 'unsupported'] as const)(
  'never sends steer fields while support is %s',
  (state) => {
    setLocalRuntimeCapabilitiesForTests(state === 'unknown' ? null : [])
    const { result } = renderHook(() =>
      useStructuredAgentSessionSends({
        sessionId: 'old-host',
        target: { kind: 'local' },
        fence: 1,
        submissions: [],
        queuedMessageIds: [],
        queue: QUEUEING,
        historyLoaded: false,
        isWorking: true
      })
    )
    act(() =>
      expect(
        result.current.send('keep me', [{ path: '/host/a.png', previewUri: '' }], {
          delivery: 'immediate'
        })
      ).toBe(false)
    )
    expect(result.current.pending).toEqual([])
  }
)

it.each([
  { ...QUEUEING, capability: 'unknown', followUpsQueue: true },
  { ...QUEUEING, capability: 'unsupported', followUpsQueue: true },
  { ...QUEUEING, capability: 'unknown', followUpsQueue: false },
  { ...QUEUEING, capability: 'unsupported', followUpsQueue: false }
] as const)('keeps the default busy draft when its Enter action is unavailable: %j', (queue) => {
  setLocalRuntimeCapabilitiesForTests(queue.capability === 'unknown' ? null : [])
  const { result } = renderHook(() =>
    useStructuredAgentSessionSends({
      sessionId: 'busy-old-host',
      target: { kind: 'local' },
      fence: 1,
      submissions: [],
      queuedMessageIds: [],
      queue,
      historyLoaded: false,
      isWorking: true
    })
  )
  act(() => {
    expect(result.current.send('keep both', [{ path: '/host/keep.png', previewUri: '' }])).toBe(
      false
    )
  })
  expect(result.current.pending).toEqual([])
  expect(mocks.call).not.toHaveBeenCalled()
})
