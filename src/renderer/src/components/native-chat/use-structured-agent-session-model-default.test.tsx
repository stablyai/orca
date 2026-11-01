import type { AgentSessionOptionResult } from '../../../../shared/agent-session/options/agent-session-options-result'
// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { AGENT_SESSION_DEFAULT_MODEL_CAPABILITY } from '../../../../shared/agent-session-default-model'
import { AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'
import { useStructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'
import { useStructuredAgentSessionSendOptions } from './use-structured-agent-session-send-options'
import { useStructuredAgentSessionSends } from './use-structured-agent-session-sends'
import { resetStructuredAgentSessionSendsForTests } from './structured-agent-session-message-sender'
import { FAST_OPTIONS } from './structured-session-option-defaults.test-fixture'
import {
  applyNativeChatSessionOptionSettingsMutation,
  resolveStructuredLaunchSeedOptions
} from '../../../../shared/native-chat/input/native-chat-session-option-defaults'
import type {
  NativeChatSessionOptionSettingsMutation,
  PersistedNativeChatSessionOptions
} from '../../../../shared/native-chat/input/native-chat-session-options'

const mocks = vi.hoisted(() => ({ call: vi.fn(), enqueue: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: vi.fn(async () => ({ unsubscribe: vi.fn() })),
  callStructuredAgentSession: mocks.call
}))
vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: mocks.enqueue
}))

const TARGET = { kind: 'local' } as const
const QUEUE = {
  capability: 'supported',
  followUpsQueue: true,
  isWorking: true,
  stopping: false,
  session: { queuedMessages: [] },
  prompts: []
} as const
const pending = () =>
  Promise.withResolvers<{
    ok: true
    value: AgentSessionOptionResult
  }>()
const resetReply = {
  ok: true,
  value: {
    key: 'model',
    value: null,
    modelDefault: true,
    options: { model: 'gpt-fast', effort: 'low' }
  }
} as const

function renderSession(initial = { sessionId: 'session-1', fence: 1 }) {
  return renderHook(
    ({ sessionId, fence }) => {
      const { mutate } = useStructuredAgentSessionMutate({
        sessionId,
        target: TARGET,
        stateRef: { current: { fence } }
      })
      const options = useStructuredAgentSessionOptions({
        agent: 'claude',
        sessionId,
        target: TARGET,
        transportEnabled: true,
        isVisible: false,
        providerVisible: true,
        fence,
        turnId: null,
        unloadedTurnRevisions: undefined,
        mutate
      })
      const sendOptions = useStructuredAgentSessionSendOptions(
        sessionId,
        undefined,
        options.sendSource
      )
      const sends = useStructuredAgentSessionSends({
        sessionId,
        target: TARGET,
        fence,
        submissions: [],
        queuedMessageIds: [],
        queue: QUEUE,
        historyLoaded: false,
        isWorking: true,
        sendSelection: sendOptions
      })
      return { ...options, sendOptions, sends }
    },
    { initialProps: initial }
  )
}

beforeEach(() => {
  resetHostModelCatalogSnapshotsForTests()
  setLocalRuntimeCapabilitiesForTests([
    AGENT_SESSION_DEFAULT_MODEL_CAPABILITY,
    AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY
  ])
  mocks.call.mockReset()
  mocks.enqueue.mockReset()
  let reads = 0
  mocks.call.mockImplementation((_target, method) =>
    method === 'agentSession.options' && reads++ === 0
      ? Promise.resolve(FAST_OPTIONS)
      : new Promise(() => {})
  )
})

afterEach(() => {
  resetStructuredAgentSessionSendsForTests()
  setLocalRuntimeCapabilitiesForTests(null)
})

it.each([false, true])(
  'keeps Default across effort and Fast persistence until an explicit model pick (full reply: %s)',
  async (fullReply) => {
    let persisted: PersistedNativeChatSessionOptions = {
      claude: { model: 'gpt-live', valuesByModel: {} }
    }
    mocks.enqueue.mockImplementation(
      (_target, mutation: NativeChatSessionOptionSettingsMutation) => {
        persisted = applyNativeChatSessionOptionSettingsMutation(persisted, mutation) ?? persisted
        return Promise.resolve()
      }
    )
    const read = mocks.call.getMockImplementation()!
    mocks.call.mockImplementation((target, method, params) => {
      if (method !== 'agentSession.setOption') {
        return read(target, method, params)
      }
      return Promise.resolve(
        params.value === null
          ? resetReply
          : {
              ok: true,
              value: {
                key: params.key,
                value: params.value,
                options: {
                  ...(fullReply || params.key === 'model' ? { model: 'gpt-fast' } : {}),
                  effort: params.key === 'effort' ? params.value : 'medium',
                  ...(params.key === 'fastMode' ? { fastMode: params.value } : {})
                }
              }
            }
      )
    })
    const { result, unmount } = renderSession()
    await waitFor(() => expect(result.current.sendOptions()).toBeDefined())
    await act(async () => {
      await result.current.optionSurface.resetOption?.('model')
    })
    expect(resolveStructuredLaunchSeedOptions(persisted, 'claude')).toBeUndefined()
    for (const effort of ['medium', 'low']) {
      await act(async () => {
        expect(await result.current.setStructuredOption('effort', effort)).toBe(true)
      })
      expect(persisted.claude?.valuesByModel?.['gpt-fast']?.effort).toBe(effort)
      expect(resolveStructuredLaunchSeedOptions(persisted, 'claude')).toBeUndefined()
      expect(
        result.current.optionSnapshot.find((row) => row.id === 'model')?.defaultChoice?.selected
      ).toBe(true)
      expect(result.current.sendOptions()?.options).toBeUndefined()
    }
    for (const fastMode of [true, false]) {
      await act(async () => {
        expect(await result.current.setStructuredOption('fastMode', fastMode)).toBe(true)
      })
      expect(persisted.claude?.valuesByModel?.['gpt-fast']?.fastMode).toBe(fastMode)
      expect(resolveStructuredLaunchSeedOptions(persisted, 'claude')).toBeUndefined()
      expect(
        result.current.optionSnapshot.find((row) => row.id === 'model')?.defaultChoice?.selected
      ).toBe(true)
      expect(result.current.sendOptions()?.options).toBeUndefined()
    }
    await act(async () => {
      expect(await result.current.setStructuredOption('model', 'gpt-fast')).toBe(true)
    })
    expect(resolveStructuredLaunchSeedOptions(persisted, 'claude')).toEqual({
      model: 'gpt-fast',
      effort: 'low',
      fastMode: 'false'
    })
    expect(
      result.current.optionSnapshot.find((row) => row.id === 'model')?.defaultChoice?.selected
    ).toBe(false)
    unmount()
  }
)

it.each(
  [true, false].flatMap((resetFirst) => [
    { id: 'effort', value: 'high', resetFirst },
    { id: 'fastMode', value: true, resetFirst }
  ])
)(
  'serializes Default reset with $id writes (reset first: $resetFirst)',
  async ({ id, value, resetFirst }) => {
    const inFlight = pending()
    const read = mocks.call.getMockImplementation()!
    mocks.call.mockImplementation((target, method, params) =>
      method === 'agentSession.setOption' ? inFlight.promise : read(target, method, params)
    )
    const { result, unmount } = renderSession()
    await waitFor(() => expect(result.current.sendOptions()).toBeDefined())
    let first: Promise<unknown> | undefined
    await act(async () => {
      first = resetFirst
        ? result.current.optionSurface.resetOption?.('model')
        : result.current.setStructuredOption(id, value)
      if (resetFirst) {
        expect(await result.current.setStructuredOption(id, value)).toBe(false)
        expect(result.current.sendOptions()?.options).toBeUndefined()
      } else {
        await result.current.optionSurface.resetOption?.('model')
      }
    })
    const writes = mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.setOption')
    expect(writes).toHaveLength(1)
    expect(writes[0]?.[2]).toMatchObject(
      resetFirst ? { key: 'model', value: null } : { key: id, value: String(value) }
    )
    await act(async () => {
      inFlight.resolve(
        resetFirst
          ? resetReply
          : { ok: true, value: { key: id, value: String(value), options: { [id]: String(value) } } }
      )
      await first
    })
    expect(
      result.current.optionSnapshot.find((row) => row.id === 'model')?.defaultChoice?.selected
    ).toBe(resetFirst)
    expect(result.current.sendOptions()?.options === undefined).toBe(resetFirst)
    unmount()
  }
)

it.each([
  { sessionId: 'session-2', fence: 1 },
  { sessionId: 'session-1', fence: 2 }
])('keeps the new context reset pending after switching to %j', async (context) => {
  const oldReset = pending()
  const newReset = pending()
  let resets = 0
  mocks.call.mockImplementation((_target, method) =>
    method === 'agentSession.setOption'
      ? ++resets === 1
        ? oldReset.promise
        : newReset.promise
      : method === 'agentSession.options' && resets < 2
        ? Promise.resolve(FAST_OPTIONS)
        : new Promise(() => {})
  )
  const { result, rerender, unmount } = renderSession()
  await waitFor(() => expect(result.current.sendOptions()).toBeDefined())
  let old: Promise<unknown> | undefined
  let newer: Promise<unknown> | undefined
  act(() => {
    old = result.current.optionSurface.resetOption?.('model')
  })
  rerender(context)
  await waitFor(() => expect(result.current.rewind).toBeDefined())
  act(() => {
    newer = result.current.optionSurface.resetOption?.('model')
  })
  expect(resets).toBe(2)
  expect(result.current.sendOptions()).toBeUndefined()
  await act(async () => {
    oldReset.resolve(resetReply)
    await old
  })
  expect(result.current.sendOptions()).toBeUndefined()
  expect(mocks.enqueue).not.toHaveBeenCalled()
  await act(async () => {
    newReset.resolve(resetReply)
    await newer
  })
  expect(
    result.current.optionSnapshot.find((entry) => entry.id === 'model')?.defaultChoice?.selected
  ).toBe(true)
  unmount()
})
