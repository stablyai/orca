// @vitest-environment happy-dom
// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../../shared/agent-session-wire'
import { useStructuredAgentSessionCommandMenu } from './structured-agent-session-command-refresh'
import { useStructuredAgentSessionRead } from './use-structured-agent-session-read'
import { useAppStore } from '@/store'
import {
  getStructuredAgentSessionReadOwner,
  resetStructuredAgentSessionReadOwnersForTests
} from './structured-agent-session-read-owner'

const mocks = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSession: mocks.subscribe
}))
const target = { kind: 'local' } as const
const otherTarget = { kind: 'environment', environmentId: 'other-host' } as const
const streams = new Map<
  string,
  { event: (event: AgentSessionSubscribeEvent) => void; close: () => void }
>()
type CommandBatchFields = Pick<
  Extract<AgentSessionSubscribeEvent, { type: 'batch' }>,
  'commands' | 'commandsChanged'
>
const batch = (sessionId = 'one', extra: CommandBatchFields = {}): AgentSessionSubscribeEvent => ({
  type: 'batch',
  sessionId,
  batch: { cursor: { epoch: 'e', sequence: 0 }, items: [], removedItemIds: [], submissions: [] },
  ...extra
})
let rejected = false
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  streams.clear()
  rejected = false
  mocks.call.mockImplementation(async (_target, method, params) => {
    if (method === 'agentSession.commands') {
      if (rejected) {
        throw new Error('unreachable')
      }
      return { commandsPending: false }
    }
    return {
      ok: true,
      page: {
        sessionId: params.sessionId,
        epoch: 'e',
        direction: 'tail',
        items: [],
        removedItemIds: [],
        submissions: [],
        window: { oldest: null, newest: null, nextCursor: { epoch: 'e', sequence: 0 } },
        liveCursor: { epoch: 'e', sequence: 0 },
        hasOlder: false,
        hasNewer: false
      }
    }
  })
  mocks.subscribe.mockImplementation(async (_target, params, event, _error, close) => {
    streams.set(params.sessionId, { event, close })
    event(batch(params.sessionId))
    return { unsubscribe: vi.fn() }
  })
})
afterEach(() => {
  cleanup()
  resetStructuredAgentSessionReadOwnersForTests()
  vi.useRealTimers()
})
const reads = () =>
  mocks.call.mock.calls.filter((call) => call[1] === 'agentSession.commands').length
function mount(sessionId = 'one', enabled = true) {
  return renderHook(
    (props) => {
      useStructuredAgentSessionRead({ sessionId: props.sessionId, target, isViewed: false })
      return useStructuredAgentSessionCommandMenu(target, props.sessionId, props.enabled)
    },
    { initialProps: { sessionId, enabled } }
  )
}

it.each([0, 1, 2])(
  'coalesces hint at position %i without transcript mutation or closed-menu work',
  async (position) => {
    const hook = mount()
    await act(async () => {})
    expect(reads()).toBe(0)
    await act(async () => hook.result.current.setOpen(true))
    expect(reads()).toBe(1)
    await act(async () => {
      for (let index = 0; index < 3; index++) {
        streams.get('one')!.event(
          batch('one', {
            commands: null,
            ...(index === position ? { commandsChanged: true } : {})
          })
        )
      }
      await vi.advanceTimersByTimeAsync(49)
    })
    expect(reads()).toBe(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_001)
    })
    expect(reads()).toBe(2)
    act(() => hook.result.current.setOpen(false))
    await act(async () => {
      streams.get('one')!.event(batch('one', { commandsChanged: true }))
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(reads()).toBe(2)
  }
)

it.each(['batch', 'snapshot'] as const)(
  'wakes a parked old-host menu on resumed %s with no hint once',
  async (shape) => {
    const hook = mount()
    await act(async () => {})
    rejected = true
    await act(async () => hook.result.current.setOpen(true))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(330_000)
    })
    expect(reads()).toBe(3)
    rejected = false
    const subscribe = mocks.subscribe.getMockImplementation()!
    mocks.subscribe.mockImplementation(async (...args) => {
      const [_target, params, event] = args
      if (shape === 'snapshot') {
        const result = await mocks.call(_target, 'agentSession.history', params)
        event({ type: 'snapshot', sessionId: params.sessionId, page: result.page, fence: 0 })
        streams.set(params.sessionId, { event, close: args[4] })
        return { unsubscribe: vi.fn() }
      }
      return subscribe(...args)
    })
    await act(async () => {
      streams.get('one')!.close()
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(reads()).toBe(4)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000)
    })
    expect(reads()).toBe(4)
  }
)

it('uses one delivery owner for legacy list loss and removes demand on disable, retarget and unmount', async () => {
  const hook = mount()
  await act(async () => {})
  const owner = getStructuredAgentSessionReadOwner('one', target)
  const subscribe = owner.subscribeCommandsChanged
  let listeners = 0
  vi.spyOn(owner, 'subscribeCommandsChanged').mockImplementation((listener) => {
    listeners++
    const stop = subscribe(listener)
    return () => {
      listeners--
      stop()
    }
  })
  await act(async () => hook.result.current.setOpen(true))
  expect(listeners).toBe(1)
  await act(async () => {
    streams.get('one')!.event(batch('one', { commands: [{ name: 'fast', kind: 'command' }] }))
    await vi.advanceTimersByTimeAsync(49)
    streams.get('one')!.event(batch('one', { commands: null, commandsChanged: true }))
    await vi.advanceTimersByTimeAsync(49)
  })
  expect(reads()).toBe(2)
  hook.rerender({ sessionId: 'one', enabled: false })
  expect(listeners).toBe(0)
  await act(async () => {
    streams.get('one')!.event(batch('one', { commandsChanged: true }))
    await vi.advanceTimersByTimeAsync(49)
  })
  expect(reads()).toBe(2)
  hook.rerender({ sessionId: 'two', enabled: true })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  const before = reads()
  await act(async () => {
    streams.get('one')!.event(batch('one', { commandsChanged: true }))
    await vi.advanceTimersByTimeAsync(49)
  })
  expect(reads()).toBe(before)
  hook.unmount()
  await act(async () => {
    streams.get('two')!.event(batch('two', { commandsChanged: true }))
    await vi.advanceTimersByTimeAsync(600_000)
  })
  expect(reads()).toBe(before)
})

it.each([3, 30])(
  'isolates %i actual read hooks: hints do not render transcript consumers',
  async (count) => {
    const renders = Array(count).fill(0)
    const hooks = renders.map((_, index) =>
      renderHook(() => {
        renders[index]++
        return {
          read: useStructuredAgentSessionRead({
            sessionId: `chat-${index}`,
            target,
            isViewed: false
          }),
          menu: useStructuredAgentSessionCommandMenu(target, `chat-${index}`, true)
        }
      })
    )
    const otherHost = renderHook(() =>
      useStructuredAgentSessionRead({
        sessionId: 'other-host-chat',
        target: otherTarget,
        isViewed: false
      })
    )
    await act(async () => {})
    expect(reads()).toBe(0)
    await act(async () => {
      hooks.forEach((hook) => hook.result.current.menu.setOpen(true))
    })
    expect(reads()).toBe(count)
    renders.fill(0)
    await act(async () => {
      streams
        .get('other-host-chat')!
        .event(batch('other-host-chat', { commands: [{ name: 'other', kind: 'command' }] }))
      await vi.advanceTimersByTimeAsync(49)
    })
    expect(renders).toEqual(Array(count).fill(0))
    otherHost.unmount()
    for (let index = 0; index < count; index++) {
      await act(async () =>
        useAppStore.setState({ removedRuntimeEnvironmentIds: new Set([`other-host-${index}`]) })
      )
      expect(renders).toEqual(Array(count).fill(0))
    }
    for (let index = 0; index < count; index++) {
      await act(async () => {
        streams.get(`chat-${index}`)!.event(batch(`chat-${index}`, { commandsChanged: true }))
        await vi.advanceTimersByTimeAsync(49)
      })
      expect(renders).toEqual(Array(count).fill(0))
      expect(reads()).toBe(count + index + 1)
    }
    await act(async () => {
      streams
        .get('chat-0')!
        .event(batch('chat-0', { commands: [{ name: 'fast', kind: 'command' }] }))
      await vi.advanceTimersByTimeAsync(49)
    })
    expect(renders[0]).toBe(1)
    expect(renders.slice(1)).toEqual(Array(count - 1).fill(0))
    expect(hooks[0]!.result.current.read.state.commands?.[0]?.name).toBe('fast')
    expect(reads()).toBe(2 * count)
  }
)
