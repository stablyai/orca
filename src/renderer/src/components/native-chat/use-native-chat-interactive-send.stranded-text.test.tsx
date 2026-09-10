// @vitest-environment happy-dom
//
// Ordering tests for the words a user types with no option to attach to.
// These drive the REAL send queue and runtime-send layer (only the PTY write is
// captured), because the defect they pin lives in the interaction between the
// answer's cancel handle and the queued chat write — a mocked send path cannot
// express it.

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  writes: [] as string[],
  storeState: { agentStatusByPaneKey: {} as Record<string, unknown> }
}))

vi.mock('../../store', () => ({ useAppStore: { getState: () => mocks.storeState } }))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: (_settings: unknown, _ptyId: string, data: string) => {
    mocks.writes.push(data)
  },
  sendRuntimePtyInputVerified: (_settings: unknown, _ptyId: string, data: string) => {
    mocks.writes.push(data)
    return Promise.resolve(true)
  }
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  getSettingsForAgentTabRuntimeOwner: (terminalTabId: string) => ({ terminalTabId })
}))

import { useNativeChatInteractiveSend } from './use-native-chat-interactive-send'
import { resetNativeChatPtySendQueuesForTests } from './native-chat-runtime-send'
import type { AskPrompt } from './native-chat-interactive-prompt'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

/** Case 1.3: one plain single-select question, three options, no pick. */
const PLAIN_SINGLE: AskPrompt = {
  questions: [
    {
      question: 'Which editor?',
      multiSelect: false,
      options: [{ label: 'Zed' }, { label: 'Orca' }, { label: 'Vim' }]
    }
  ]
}

/** Case 2.3: one plain multi-select question, three options, nothing checked.
 *  The checkbox layout numbers its chat row the same as the single-select one,
 *  so the escape sequence must not vary by layout. */
const PLAIN_MULTI: AskPrompt = {
  questions: [
    {
      question: 'Which languages?',
      multiSelect: true,
      options: [{ label: 'Rust' }, { label: 'Swift' }, { label: 'TypeScript' }]
    }
  ]
}

/** Case M.3: question 1 answered by pick, question 2 by prose only. */
const MIXED: AskPrompt = {
  questions: [
    { question: 'Editor', multiSelect: false, options: [{ label: 'Zed' }, { label: 'Orca' }] },
    {
      question: 'Runtime',
      multiSelect: false,
      options: [
        { label: 'Node', hasPreview: true },
        { label: 'Bun', hasPreview: true }
      ]
    }
  ]
}

const wrote = (needle: string): boolean => mocks.writes.some((w) => w.includes(needle))

describe('stranded text reaches chat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.writes = []
    mocks.storeState = { agentStatusByPaneKey: {} }
    resetNativeChatPtySendQueuesForTests()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { agentStatus: { inferQuestionAnswered: () => Promise.resolve(true) } }
    })
  })

  it('case 1.3: escape-to-chat survives the dismissal that follows the chat row', async () => {
    const { result } = renderHook(() =>
      useNativeChatInteractiveSend('tab-1', PANE_KEY, 'pty-1', 'claude')
    )

    act(() => result.current.escapeToChat(PLAIN_SINGLE, 'I would rather use Helix'))
    // Selecting the chat row resolves the ask, so the card's cleanup runs its
    // cancelPending() while the body is still queued.
    act(() => result.current.cancelPending())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })

    // Row digit is options.length + 2.
    expect(mocks.writes[0]).toBe('5')
    expect(wrote('I would rather use Helix')).toBe(true)
    // The words follow the row rather than racing it.
    expect(mocks.writes.findIndex((w) => w.includes('I would rather use Helix'))).toBeGreaterThan(0)
  })

  it('case 2.3: a multi-select with no checkbox ticked escapes through the same chat row', async () => {
    const { result } = renderHook(() =>
      useNativeChatInteractiveSend('tab-1', PANE_KEY, 'pty-1', 'claude')
    )

    act(() => result.current.escapeToChat(PLAIN_MULTI, 'I prefer Zig'))
    act(() => result.current.cancelPending())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })

    // Checkbox rows do not shift the chat row: it stays options.length + 2.
    expect(mocks.writes[0]).toBe('5')
    expect(wrote('I prefer Zig')).toBe(true)
    expect(mocks.writes.findIndex((w) => w.includes('I prefer Zig'))).toBeGreaterThan(0)
    // No Submit-tab keystroke may follow the row, which would re-enter the selector.
    expect(mocks.writes.some((w) => w === '\x1b[C' || w === '\t')).toBe(false)
  })

  it('case M.3: the stranded question survives a cancel while the answer is in flight', async () => {
    const { result } = renderHook(() =>
      useNativeChatInteractiveSend('tab-1', PANE_KEY, 'pty-1', 'claude')
    )

    act(() => {
      result.current.sendAnswer(
        MIXED,
        [
          { indices: [0], other: '' },
          { indices: [], other: '' }
        ],
        undefined,
        'Runtime\nI want Deno instead'
      )
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    act(() => result.current.cancelPending())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000)
    })

    expect(wrote('I want Deno instead')).toBe(true)
  })

  it('case M.3: the stranded question follows a fully settled answer exactly once', async () => {
    const { result } = renderHook(() =>
      useNativeChatInteractiveSend('tab-1', PANE_KEY, 'pty-1', 'claude')
    )

    act(() => {
      result.current.sendAnswer(
        MIXED,
        [
          { indices: [0], other: '' },
          { indices: [], other: '' }
        ],
        undefined,
        'Runtime\nI want Deno instead'
      )
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000)
    })
    act(() => result.current.cancelPending())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })

    expect(mocks.writes.filter((w) => w.includes('I want Deno instead'))).toHaveLength(1)
  })

  it('sends nothing extra when every question was answered by a pick', async () => {
    const { result } = renderHook(() =>
      useNativeChatInteractiveSend('tab-1', PANE_KEY, 'pty-1', 'claude')
    )

    act(() => {
      result.current.sendAnswer(PLAIN_SINGLE, [{ indices: [1], other: '' }], undefined, '')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000)
    })
    act(() => result.current.cancelPending())

    expect(mocks.writes.every((w) => w.length <= 2)).toBe(true)
  })
})
