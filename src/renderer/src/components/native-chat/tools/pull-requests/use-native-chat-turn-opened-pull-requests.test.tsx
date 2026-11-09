// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import {
  NativeChatVisualOwnerContext,
  type NativeChatVisualOwner
} from '../../media/visuals/native-chat-visual-owner'
import { useNativeChatTurnOpenedPullRequests } from './use-native-chat-turn-opened-pull-requests'

const host = vi.hoisted(() => ({ capability: vi.fn(), read: vi.fn() }))

vi.mock(
  '../../../../runtime/native-chat/host-capabilities/structured-agent-session-host-support',
  () => ({
    structuredAgentSessionHostCapabilityState: host.capability
  })
)

vi.mock('../../../../runtime/native-chat/journal/structured-agent-session-journal-reads', () => ({
  readStructuredAgentSessionItem: host.read
}))
vi.mock('@/store', () => ({
  useAppStore: (select: (state: { settings: object }) => unknown) => select({ settings: {} })
}))

const OWNER: NativeChatVisualOwner = {
  target: { kind: 'local' },
  sessionId: 'session-1',
  worktreeId: 'wt-1'
}

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <NativeChatVisualOwnerContext.Provider value={OWNER}>
      {children}
    </NativeChatVisualOwnerContext.Provider>
  )
}

// A create call whose output reached the chat cut before gh printed the URL.
function clippedCreate(id: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    timestamp: 1,
    source: 'transcript',
    blocks: [
      { type: 'tool-call', name: 'Bash', input: { command: 'gh pr create --fill' }, callId: id },
      { type: 'tool-result', output: 'pre-push hook output…', callId: id, fullOutputItemId: id }
    ]
  }
}

function wholeOutput(id: string, number: number): unknown {
  return {
    itemId: id,
    body: {
      kind: 'tool-call',
      output: {
        head: `hooks…\nhttps://github.com/o/r/pull/${number}\n`,
        byteLength: 1,
        digest: 'd'
      }
    }
  }
}

function turns(messages: NativeChatMessage[]) {
  return { messages, turnKeys: messages.map(() => 'turn-1'), liveTurnKey: undefined }
}

function cardNumbers(result: { current: ReturnType<typeof useNativeChatTurnOpenedPullRequests> }) {
  return result.current.byTurn.get('turn-1')?.map(({ number }) => number) ?? []
}

// A minute at a time, so each retry's render and its next read run between steps.
async function advance(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed <= ms; elapsed += 60_000) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(60_000, ms - elapsed))
    })
  }
}

describe('useNativeChatTurnOpenedPullRequests', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    host.capability.mockReset()
    host.read.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows each clipped create card once its host answers, retrying every output on its own', async () => {
    // A's host is unreachable at first, then its reads fail twice before one answers.
    host.capability.mockResolvedValueOnce('unknown').mockResolvedValue('supported')
    host.read
      .mockRejectedValueOnce(new Error('disconnected'))
      .mockRejectedValueOnce(new Error('disconnected'))
      .mockResolvedValueOnce(wholeOutput('a', 1))
    const { result, rerender } = renderHook(
      ({ rows }) => useNativeChatTurnOpenedPullRequests(rows, []),
      {
        wrapper,
        initialProps: { rows: turns([clippedCreate('a')]) }
      }
    )
    await advance(0)
    expect(cardNumbers(result)).toEqual([])
    await advance(10 * 60_000)
    expect(cardNumbers(result)).toEqual([1])

    // B's first read fails too; it recovers with no further transcript change or tab switch.
    host.read
      .mockRejectedValueOnce(new Error('disconnected'))
      .mockResolvedValueOnce(wholeOutput('b', 2))
    rerender({ rows: turns([clippedCreate('a'), clippedCreate('b')]) })
    await advance(0)
    expect(cardNumbers(result)).toEqual([1])
    await advance(10 * 60_000)
    expect(cardNumbers(result)).toEqual([1, 2])
  })
})
