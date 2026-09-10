// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type * as MessageRowModule from './NativeChatMessageRow'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from './use-native-chat-live-session'

// Counting REAL row renders rather than props: the transcript is not windowed, so a prop that
// changes on every row re-renders the entire chat — the cost the row memo exists to prevent.
const renders = vi.hoisted(() => ({ byId: new Map<string, number>() }))
vi.mock('./NativeChatMessageRow', async (importOriginal) => {
  const actual = await importOriginal<typeof MessageRowModule>()
  const { createElement, memo } = await import('react')
  const Wrapped = (props: React.ComponentProps<typeof actual.MessageRow>) => {
    renders.byId.set(props.message.id, (renders.byId.get(props.message.id) ?? 0) + 1)
    return createElement(actual.MessageRow, props)
  }
  // memo() so the parent's re-render alone does not re-run it; only a changed prop does.
  return { ...actual, MessageRow: memo(Wrapped) }
})

const { NativeChatMessageList } = await import('./NativeChatMessageList')
afterEach(cleanup)

const TURNS = 12
const ANCHOR = `assistant-${TURNS - 1}`

function messages(): NativeChatMessage[] {
  return Array.from({ length: TURNS }, (_, index) => index).flatMap((index) => [
    {
      id: `user-${index}`,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: `ask ${index}` }],
      timestamp: index * 2 + 1,
      source: 'transcript' as const
    },
    {
      id: `assistant-${index}`,
      role: 'assistant' as const,
      blocks: [{ type: 'text' as const, text: `answer ${index}` }],
      timestamp: index * 2 + 2,
      source: 'transcript' as const
    }
  ])
}

// Hoisted: a transcript rebuilt per render hands every row a new `message` and would bust the memo
// for reasons that have nothing to do with the prop under test.
const MESSAGES = messages()
const onFork = () => {}
const loadEarlier = () => {}

function Transcript({ pending }: { pending: boolean }) {
  const session: NativeChatLiveSession = {
    messages: MESSAGES,
    status: 'ready',
    sessionId: 'session',
    agent: 'codex',
    hasMore: false,
    loadingEarlier: false,
    loadEarlier,
    readPhase: 'ready'
  }
  return (
    <NativeChatMessageList
      session={session}
      isWorking={false}
      expandSignal
      fontScale={1}
      showTurnStatus={false}
      forkAction={{ eligibleIds: new Set([ANCHOR]), onFork, pending }}
    />
  )
}

it('re-renders only the anchor row when a fork goes pending', () => {
  const { rerender } = render(<Transcript pending={false} />)
  expect(renders.byId.get(ANCHOR)).toBe(1)
  renders.byId.clear()
  rerender(<Transcript pending />)
  // The anchor is the one row that reads `pending`, so it is the only one allowed to re-render.
  expect(renders.byId.get(ANCHOR)).toBe(1)
  expect([...renders.byId].filter(([id]) => id !== ANCHOR)).toEqual([])
})
