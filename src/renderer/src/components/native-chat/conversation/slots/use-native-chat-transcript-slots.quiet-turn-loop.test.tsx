// @vitest-environment happy-dom
// A quiet turn that settles while the chat still reads working must fade once, not loop (React #185).
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { useNativeChatTranscriptSlots } from './use-native-chat-transcript-slots'

type Input = Parameters<typeof useNativeChatTranscriptSlots>[0]

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const WORKER: NativeChatMessage['from'] = { kind: 'agent', senders: [], orchestration: null }
const row = (
  id: string,
  role: NativeChatMessage['role'],
  text: string,
  extra: Partial<NativeChatMessage> = {}
): NativeChatMessage => ({
  id,
  role,
  timestamp: 1,
  source: 'transcript',
  blocks: [{ type: 'text', text }],
  ...extra
})

// A bot chat's quiet turn: a worker's mail opened it and the bot answered with only the marker.
const messages = [row('w1', 'user', 'done', { from: WORKER }), row('a1', 'assistant', 'NO_REPLY')]
const turnKeys = ['w1', 'w1']
const SETTLED = { w1: { startedAt: 0, thinking: false, workedSeconds: 9 } }
const RUNNING = {}
const stable = {
  receipts: new Map(),
  turnDiffs: new Map(),
  expandedTurnKeys: new Set<string>(),
  line: { tailRow: null, thinking: false }
} satisfies Partial<Input>

function input(overrides: Partial<Input>): Input {
  return {
    ...stable,
    messages,
    turnKeys,
    // The newest user turn stays the live key after it settles (nativeChatTurnMembership fallback).
    liveTurnKey: 'w1',
    turnStatuses: { active: null, completedByTurn: SETTLED },
    isWorking: false,
    lifecycleWorking: false,
    ...overrides
  }
}

function rows(slots: ReturnType<typeof useNativeChatTranscriptSlots>['slots']) {
  return slots.flatMap((slot) =>
    slot.kind === 'message' ? [[slot.message.id, slot.leaving ?? null]] : []
  )
}
// The answer row, which carries the turn's bar, draws one moment longer to fade out.
const FADING = [
  ['w1', null],
  ['a1', 'row']
]
const GONE = [['w1', null]]

describe('a quiet turn that is settled while the chat still reads working', () => {
  it('fades once when the settled duration lands a render before working ends', () => {
    const hook = renderHook((props: Input) => useNativeChatTranscriptSlots(props), {
      initialProps: input({
        isWorking: true,
        turnStatuses: { active: null, completedByTurn: RUNNING }
      })
    })
    // The host's settled duration arrives; the working flag has not dropped yet.
    expect(() =>
      hook.rerender(
        input({ isWorking: true, turnStatuses: { active: null, completedByTurn: SETTLED } })
      )
    ).not.toThrow()
    expect(rows(hook.result.current.slots)).toEqual(FADING)
  })

  it('does not loop when work resumes on a settled quiet turn before a new turn opens', () => {
    const hook = renderHook((props: Input) => useNativeChatTranscriptSlots(props), {
      initialProps: input({})
    })
    // The session lifecycle reads working again; the next turn's opening row has not arrived.
    hook.rerender(input({ lifecycleWorking: true }))
    // Any transcript rebuild in that window (here, the same rows in a new array).
    expect(() =>
      hook.rerender(input({ lifecycleWorking: true, messages: [...messages] }))
    ).not.toThrow()
    // It was already quiet, so it is not drawn and does not fade.
    expect(rows(hook.result.current.slots)).toEqual(GONE)
  })
})

describe('a quiet turn that settles while the chat shows it working', () => {
  it('fades, then goes', () => {
    vi.useFakeTimers()
    const hook = renderHook((props: Input) => useNativeChatTranscriptSlots(props), {
      initialProps: input({
        isWorking: true,
        turnStatuses: { active: null, completedByTurn: RUNNING }
      })
    })
    hook.rerender(input({}))
    expect(rows(hook.result.current.slots)).toEqual(FADING)
    act(() => vi.runAllTimers())
    expect(rows(hook.result.current.slots)).toEqual(GONE)
  })

  it('fades again when the host reopens the turn and it settles quiet again', () => {
    vi.useFakeTimers()
    const running = input({
      isWorking: true,
      turnStatuses: { active: null, completedByTurn: RUNNING }
    })
    const hook = renderHook((props: Input) => useNativeChatTranscriptSlots(props), {
      initialProps: running
    })
    hook.rerender(input({}))
    act(() => vi.runAllTimers())
    expect(rows(hook.result.current.slots)).toEqual(GONE)
    // Reopened: its settled entry goes away, so it is no longer quiet and is watched again.
    hook.rerender(running)
    hook.rerender(input({ isWorking: true }))
    expect(rows(hook.result.current.slots)).toEqual(FADING)
    act(() => vi.runAllTimers())
    expect(rows(hook.result.current.slots)).toEqual(GONE)
  })

  it('restarts the fade when the turn reopens and settles again before the first fade ends', () => {
    vi.useFakeTimers()
    const running = input({
      isWorking: true,
      turnStatuses: { active: null, completedByTurn: RUNNING }
    })
    const hook = renderHook((props: Input) => useNativeChatTranscriptSlots(props), {
      initialProps: running
    })
    hook.rerender(input({}))
    act(() => vi.advanceTimersByTime(550))
    hook.rerender(running)
    hook.rerender(input({ isWorking: true }))
    // Past the first fade's deadline, but only 100 ms into the second fade.
    act(() => vi.advanceTimersByTime(100))
    expect(rows(hook.result.current.slots)).toEqual(FADING)
    act(() => vi.runAllTimers())
    expect(rows(hook.result.current.slots)).toEqual(GONE)
  })
})
