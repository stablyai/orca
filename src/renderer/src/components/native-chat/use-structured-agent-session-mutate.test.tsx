// @vitest-environment happy-dom

// One press is one action: a later press of the same control is never answered from an earlier one.

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  hostAnswersRepeatedStops: vi.fn(async () => false),
  toastError: vi.fn(),
  operations: 0
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, message: vi.fn() } }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionQuietRepeatedStop: mocks.hostAnswersRepeatedStops
}))

vi.mock('./structured-agent-session-operation-id', () => ({
  structuredSessionOperationId: () => `operation-${++mocks.operations}`
}))

import { useStructuredAgentSessionMutate } from './use-structured-agent-session-mutate'

type Params = {
  envelope: { clientOperationId: string }
  key?: string
  value?: string
  change?: { kind: 'set'; objective: string } | { kind: 'clear' }
}
type Answer =
  | { ok: true; value: unknown }
  | { ok: false; refusal: { code: string; message: string } }

const LOST = new Error('the connection dropped before the host answered')
const CONFLICT = {
  ok: false,
  refusal: { code: 'agent_session_conflict', message: 'The chat changed.' }
} as const

/** The host's ledger: an id it already ran gets that answer again, and nothing runs. */
function ledgerHost(run: (method: string, params: Params) => Answer) {
  const ledger = new Map<string, Answer>()
  const ids: string[] = []
  let lostAnswers = 0
  mocks.call.mockImplementation(async (_target, method: string, params: Params) => {
    const id = params.envelope.clientOperationId
    ids.push(id)
    const answer = ledger.get(id) ?? run(method, params)
    if (answer.ok) {
      ledger.set(id, answer)
    }
    if (lostAnswers > 0) {
      lostAnswers -= 1
      throw LOST
    }
    return answer
  })
  return {
    ids,
    /** The host runs the next write, but its answer never reaches the client. */
    loseNextAnswer: () => {
      lostAnswers += 1
    }
  }
}

function render() {
  return renderHook(() =>
    useStructuredAgentSessionMutate({
      sessionId: 'session-1',
      target: { kind: 'local' },
      stateRef: { current: { fence: 3 } }
    })
  ).result
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.hostAnswersRepeatedStops.mockResolvedValue(false)
  mocks.operations = 0
})

describe('a write pressed again', () => {
  it('applies an option picked again after a pick whose answer was lost', async () => {
    let option: unknown = null
    const host = ledgerHost((_method, params) => {
      option = params.value
      return { ok: true, value: { key: params.key, value: params.value } }
    })
    const { current } = render()

    host.loseNextAnswer()
    for (const value of ['A', 'B', 'A']) {
      await act(async () => {
        await current.mutate('agentSession.setOption', 'agentSession.setOption', {
          key: 'model',
          value
        })
      })
    }

    expect(option).toBe('A')
    expect(new Set(host.ids).size).toBe(3)
  })

  it('sets a goal again after it was cleared, when the first set lost its answer', async () => {
    let goal: string | null = null
    const host = ledgerHost((_method, params) => {
      goal = params.change?.kind === 'set' ? params.change.objective : null
      return { ok: true, value: { change: params.change?.kind } }
    })
    const { current } = render()
    const set = { change: { kind: 'set', objective: 'Ship the parser' } }

    host.loseNextAnswer()
    for (const fields of [set, { change: { kind: 'clear' } }, set]) {
      await act(async () => {
        await current.mutate('agentSession.threadGoal', 'agentSession.threadGoal', fields)
      })
    }

    expect(goal).toBe('Ship the parser')
  })

  it('says nothing when the same answer is clicked again after its reply was lost', async () => {
    const resolution = { state: 'resolved', selectedOptionId: 'allow' }
    // A host that already resolved the prompt that way answers with the resolution it holds.
    const host = ledgerHost(() => ({
      ok: true,
      value: { itemId: 'item-1', revision: 2, resolution }
    }))
    const { current } = render()
    const answer = { itemId: 'item-1', expectedRevision: 1, optionId: 'allow' }

    host.loseNextAnswer()
    let second: unknown
    await act(async () => {
      await current.mutate(
        'agentSession.respondToApproval',
        'agentSession.respondTo:approval',
        answer
      )
      mocks.toastError.mockClear()
      second = await current.mutate(
        'agentSession.respondToApproval',
        'agentSession.respondTo:approval',
        answer
      )
    })

    expect(second).toMatchObject({ resolution })
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(host.ids[1]).not.toBe(host.ids[0])
  })
})

describe('a conversation command typed again', () => {
  it('goes out as a new command, which the host resumes or runs', async () => {
    const ids: string[] = []
    mocks.call.mockImplementation(async (_target, _method, params: Params) => {
      ids.push(params.envelope.clientOperationId)
      if (ids.length === 1) {
        throw LOST
      }
      return { ok: true, value: { command: 'clear', state: 'completed' } }
    })
    const { current } = render()

    for (let press = 0; press < 2; press += 1) {
      await act(async () => {
        await current.write(
          'agentSession.conversationCommand',
          'agentSession.conversationCommand',
          { command: 'clear' }
        )
      })
    }

    expect(ids).toHaveLength(2)
    expect(ids[1]).not.toBe(ids[0])
  })
})

/** A host that holds each Stop until the test answers the ones it was sent. */
function heldStops() {
  const answers: (() => void)[] = []
  const ids: string[] = []
  mocks.call.mockImplementation((_target, _method, params: Params) => {
    ids.push(params.envelope.clientOperationId)
    return new Promise((resolve) =>
      answers.push(() => resolve({ ok: true, value: { turnId: 'turn-1', cancelled: true } }))
    )
  })
  return {
    ids,
    answerWhenSent: async (count: number) => {
      await vi.waitFor(() => expect(answers).toHaveLength(count))
      answers.splice(0).forEach((answer) => answer())
    }
  }
}

const stop = (current: ReturnType<typeof render>['current'], turnId = 'turn-1') =>
  current.mutate('agentSession.cancel', 'agentSession.cancel', { turnId })

it.each([
  [false, { turnId: 'turn-1' }],
  [true, { turnId: 'turn-1' }],
  [true, { turnId: 'background-tasks', scope: 'background-tasks', taskId: 'task-command' }]
] as const)('keeps an admitted Stop after closure (quiet=%s, %j)', async (quiet, fields) => {
  const capability = Promise.withResolvers<boolean>()
  mocks.hostAnswersRepeatedStops.mockReturnValue(capability.promise)
  mocks.call.mockResolvedValue({ ok: true, value: { cancelled: true } })
  const stateRef = { current: { fence: 3 } }
  const target = { kind: 'environment', environmentId: 'host-A' } as const
  const view = renderHook(() =>
    useStructuredAgentSessionMutate({ sessionId: 'session-A', target, stateRef })
  )
  const isCurrent = view.result.current.capturePresentation()
  const pending = view.result.current.write('agentSession.cancel', 'agentSession.cancel', fields)
  expect(mocks.call).not.toHaveBeenCalled()
  stateRef.current.fence = 4
  view.unmount()
  capability.resolve(quiet)
  expect(await pending).toEqual({ kind: 'done', value: { cancelled: true } })
  expect(mocks.call).toHaveBeenCalledExactlyOnceWith(target, 'agentSession.cancel', {
    ...fields,
    envelope: {
      sessionId: 'session-A',
      clientOperationId: 'operation-1',
      expectedRuntimeFence: 3,
      payloadFingerprint: expect.any(String)
    }
  })
  expect(isCurrent()).toBe(false)
})

it.each([false, true])('reports only current host Stops (%s)', async (reportCurrent) => {
  const first = Promise.withResolvers<unknown>()
  mocks.call.mockReturnValueOnce(first.promise).mockResolvedValue({ ok: true, value: 'B' })
  const view = renderHook(
    ({ environmentId }) =>
      useStructuredAgentSessionMutate({
        sessionId: 'session-1',
        target: { kind: 'environment', environmentId },
        stateRef: { current: { fence: 3 } }
      }),
    { initialProps: { environmentId: 'A' } }
  )
  const pendingA = stop(view.result.current)
  await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
  view.rerender({ environmentId: 'B' })
  expect(await stop(view.result.current)).toBe('B')
  view.rerender({ environmentId: 'A' })
  const currentPresses = reportCurrent ? [stop(view.result.current), stop(view.result.current)] : []
  const raw = view.result.current.write('agentSession.cancel', 'agentSession.cancel', {
    turnId: 'turn-1'
  })
  await vi.waitFor(() =>
    expect(mocks.hostAnswersRepeatedStops).toHaveBeenCalledTimes(reportCurrent ? 5 : 3)
  )
  first.resolve(CONFLICT)
  expect(await Promise.all([pendingA, ...currentPresses])).toEqual(
    reportCurrent ? [null, null, null] : [null]
  )
  const outcome = await raw
  expect(outcome).toMatchObject({
    kind: 'not-done',
    notice: expect.any(String),
    failure: { kind: 'refused', code: 'agent_session_conflict' }
  })
  expect(mocks.toastError).toHaveBeenCalledTimes(reportCurrent ? 1 : 0)
  if (reportCurrent && outcome.kind === 'not-done') {
    expect(mocks.toastError).toHaveBeenCalledWith(outcome.notice)
  }
  expect(mocks.call.mock.calls.map(([target]) => target.environmentId)).toEqual(['A', 'B'])
})

describe('a Stop pressed again, against a host without the quiet repeated Stop', () => {
  it('joins the one still in flight instead of sending a second', async () => {
    const host = heldStops()
    const { current } = render()

    let first: Promise<unknown> = Promise.resolve()
    let second: Promise<unknown> = Promise.resolve()
    act(() => {
      first = stop(current)
      second = stop(current)
    })
    await act(async () => {
      await host.answerWhenSent(1)
      await Promise.all([first, second])
    })

    expect(mocks.call).toHaveBeenCalledOnce()
    expect(await second).toEqual(await first)
  })

  it('reports a failed Stop once, not once per press that joined it', async () => {
    const answers: (() => void)[] = []
    mocks.call.mockImplementation(
      () => new Promise((_resolve, reject) => answers.push(() => reject(LOST)))
    )
    const { current } = render()

    await act(async () => {
      const pressed = [stop(current), stop(current)]
      await vi.waitFor(() => expect(answers).toHaveLength(1))
      answers.splice(0).forEach((answer) => answer())
      await Promise.all(pressed)
    })

    expect(mocks.call).toHaveBeenCalledOnce()
    expect(mocks.toastError).toHaveBeenCalledOnce()
  })

  it('keeps repeated raw failures truthful without reporting them', async () => {
    const failure = Promise.withResolvers<unknown>()
    mocks.call.mockReturnValue(failure.promise)
    const { current } = render()
    const writes = [
      current.write('agentSession.cancel', 'agentSession.cancel', { turnId: 'turn-1' }),
      current.write('agentSession.cancel', 'agentSession.cancel', { turnId: 'turn-1' })
    ]
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    failure.resolve(CONFLICT)
    for (const outcome of await Promise.all(writes)) {
      expect(outcome).toMatchObject({
        kind: 'not-done',
        notice: expect.any(String),
        failure: { kind: 'refused', code: 'agent_session_conflict' }
      })
    }
    expect(mocks.call).toHaveBeenCalledOnce()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('sends a new Stop once the first has settled', async () => {
    const host = heldStops()
    const { current } = render()

    for (let press = 0; press < 2; press += 1) {
      await act(async () => {
        const pressed = stop(current)
        await host.answerWhenSent(1)
        await pressed
      })
    }

    const { ids } = host
    expect(ids).toHaveLength(2)
    expect(ids[1]).not.toBe(ids[0])
  })

  it('sends a Stop naming no turn of its own, since it stops whatever then runs', async () => {
    const host = heldStops()
    const { current } = render()

    await act(async () => {
      const pressed = [
        current.mutate('agentSession.cancel', 'agentSession.cancel', {}),
        current.mutate('agentSession.cancel', 'agentSession.cancel', {})
      ]
      await host.answerWhenSent(2)
      await Promise.all(pressed)
    })

    expect(host.ids).toHaveLength(2)
  })

  it('sends a Stop of another turn even while one is in flight', async () => {
    const host = heldStops()
    const { current } = render()

    await act(async () => {
      const pressed = [stop(current, 'turn-1'), stop(current, 'turn-2')]
      await host.answerWhenSent(2)
      await Promise.all(pressed)
    })

    expect(mocks.call).toHaveBeenCalledTimes(2)
  })
})

describe('a Stop pressed again, against a host that answers a repeat quietly', () => {
  it('sends every press under its own id, even while an earlier one is on its way', async () => {
    mocks.hostAnswersRepeatedStops.mockResolvedValue(true)
    const host = heldStops()
    const { current } = render()

    await act(async () => {
      const pressed = [stop(current), stop(current)]
      await host.answerWhenSent(2)
      await Promise.all(pressed)
    })

    expect(new Set(host.ids).size).toBe(2)
  })
})
