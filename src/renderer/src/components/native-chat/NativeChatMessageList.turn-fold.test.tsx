// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'

let restoreViewport = (): void => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())
afterEach(cleanup)

const NARRATION = 'I am starting with the required readiness pass.'
const MORE_NARRATION = 'The branch is current and the reference corpus is refreshed.'
const ANSWER = 'Review complete: clean after fixes.'

function session(startedAt: number): NativeChatLiveSession {
  return {
    messages: [
      {
        id: 'user-1',
        role: 'user',
        blocks: [{ type: 'text', text: 'Please review this PR.' }],
        timestamp: startedAt,
        source: 'transcript'
      },
      {
        id: 'narration-1',
        role: 'assistant',
        blocks: [{ type: 'text', text: NARRATION }],
        timestamp: startedAt + 1,
        source: 'transcript'
      },
      {
        id: 'work-1',
        role: 'assistant',
        blocks: [
          { type: 'tool-call', name: 'shell', input: { command: 'pnpm test' }, state: 'completed' },
          { type: 'tool-result', output: 'ok' }
        ],
        timestamp: startedAt + 2,
        source: 'transcript'
      },
      {
        id: 'narration-2',
        role: 'assistant',
        blocks: [{ type: 'text', text: MORE_NARRATION }],
        timestamp: startedAt + 3,
        source: 'transcript'
      },
      {
        id: 'answer-1',
        role: 'assistant',
        blocks: [{ type: 'text', text: ANSWER }],
        timestamp: startedAt + 4,
        source: 'transcript'
      }
    ],
    status: 'ready',
    sessionId: 'session-1',
    agent: 'codex',
    hasMore: false,
    loadingEarlier: false,
    olderHistoryGeneration: 0,
    loadEarlier: vi.fn(),
    readPhase: 'ready'
  }
}

// A finished turn is the transcript's resting state, and it should read as the
// answer to the prompt — not as the transcript of the work that produced it.
describe('NativeChatMessageList settled turn fold', () => {
  it('shows a settled turn as its prompt, its duration and its answer', () => {
    const startedAt = Date.now() - 3000
    render(
      <NativeChatMessageList
        session={session(startedAt)}
        isWorking={false}
        workingStartedAt={startedAt}
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(screen.getByText('Please review this PR.')).toBeInTheDocument()
    expect(screen.getByText(ANSWER)).toBeInTheDocument()
    expect(screen.queryByText(NARRATION)).toBeNull()
    expect(screen.queryByText(MORE_NARRATION)).toBeNull()
    expect(screen.getByRole('button', { name: 'Toggle turn details' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })

  it('returns the whole turn when the reader opens it', () => {
    const startedAt = Date.now() - 3000
    render(
      <NativeChatMessageList
        session={session(startedAt)}
        isWorking={false}
        workingStartedAt={startedAt}
        expandSignal={false}
        fontScale={1}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Toggle turn details' }))

    expect(screen.getByText(NARRATION)).toBeInTheDocument()
    expect(screen.getByText(MORE_NARRATION)).toBeInTheDocument()
    expect(screen.getByText(ANSWER)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Toggle turn details' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  })

  // Nothing closes the disclosure when a turn ends; the fold arrives already
  // closed. While the turn runs there is no fold at all, so the reader watches
  // the work happen.
  it('folds nothing while the turn is still running', () => {
    const startedAt = Date.now() - 3000
    render(
      <NativeChatMessageList
        session={{ ...session(startedAt), status: 'working' }}
        isWorking
        workingStartedAt={startedAt}
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(screen.getByText(NARRATION)).toBeInTheDocument()
    expect(screen.getByText(MORE_NARRATION)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Toggle turn details' })).toBeNull()
  })

  // The answer is the LAST prose the agent produced. A turn whose final output
  // is a tool run still answers with the prose before it.
  it('keeps the last prose row when the turn ends on tool activity', () => {
    const startedAt = Date.now() - 3000
    const base = session(startedAt)
    render(
      <NativeChatMessageList
        session={{
          ...base,
          messages: [
            ...base.messages,
            {
              id: 'work-2',
              role: 'assistant',
              blocks: [
                {
                  type: 'tool-call',
                  name: 'shell',
                  input: { command: 'git push' },
                  state: 'completed'
                },
                { type: 'tool-result', output: 'done' }
              ],
              timestamp: startedAt + 5,
              source: 'transcript'
            }
          ]
        }}
        isWorking={false}
        workingStartedAt={startedAt}
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(screen.getByText(ANSWER)).toBeInTheDocument()
    expect(screen.queryByText(NARRATION)).toBeNull()
  })
})
