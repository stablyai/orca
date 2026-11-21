// @vitest-environment happy-dom
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { targetBotLinkItem, useBotLinkPrompt } from '@/lib/agent-session/open/bot-link-item-target'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatTranscriptSlot } from '../../conversation/slots/native-chat-transcript-slots'
import {
  useNativeChatNavigation,
  useNativeChatNavigationRequest
} from './use-native-chat-transcript-navigation'

const none = () => {}
const loaded: NativeChatTranscriptSlot[] = [
  {
    kind: 'message',
    message: {
      id: 'answered',
      role: 'assistant',
      source: 'transcript',
      blocks: [{ type: 'text', text: 'Answer recorded.' }],
      timestamp: 1
    },
    turnKey: undefined,
    activeTurnIsWorking: false,
    trailingRun: false,
    receipt: undefined,
    status: undefined,
    folded: false,
    drawsMessage: true,
    turnFolds: false,
    turnDiff: undefined,
    estimatedHeight: 48
  }
]
const questions: AgentJournalRenderItem[] = ['Earlier question', 'Linked question'].map(
  (question, index) => ({
    itemId: `pending-${index}`,
    sequence: index + 1,
    revision: 0,
    observedAt: 1,
    body: {
      kind: 'question',
      question,
      options: [],
      resolution: { state: 'pending', selectedOptionId: null, resolvedAt: null, resolvedBy: null }
    }
  })
)

function Transcript({
  visible,
  pending = false,
  output = 1,
  rows = loaded
}: {
  visible: boolean
  pending?: boolean
  output?: number
  rows?: NativeChatTranscriptSlot[]
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  const readerLeavesEnd = useCallback(() => setFollowing(false), [])
  const returnToEnd = useCallback(() => setFollowing(true), [])
  const scrollMessageToTop = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 120
    }
  }, [])
  const loadEarlier = useCallback(async () => 'exhausted' as const, [])
  const selected = useBotLinkPrompt('session-1', pending ? questions : [])
  const request = useNativeChatNavigationRequest(rows)
  useNativeChatNavigation({
    request,
    rail: { items: [], onActivate: none },
    slots: rows,
    conversation: [],
    subagentRows: new Map(),
    roster: undefined,
    journalItems: pending ? questions : [],
    subagentId: null,
    sessionKey: 'session-1',
    sessionId: 'session-1',
    isVisible: visible,
    loadEarlier,
    holdHistory: none,
    releaseHistory: none,
    scrollRef,
    scrollMessageToTop,
    readerLeavesEnd,
    scrollToBottom: returnToEnd,
    unfoldTurnOf: () => false
  })
  useLayoutEffect(() => {
    if (following && scrollRef.current) {
      scrollRef.current.scrollTop = output * 100
    }
  }, [following, output])
  return (
    <>
      <div ref={scrollRef} data-testid="scroll" onScroll={readerLeavesEnd}>
        {rows.length > 0 && <div data-index="0">Answer recorded.</div>}
      </div>
      <output>{following ? 'Following newest' : 'Reading earlier'}</output>
      <p>{selected?.body.kind === 'question' ? selected.body.question : ''}</p>
    </>
  )
}

afterEach(() => {
  cleanup()
  targetBotLinkItem('session-1')
})

it('keeps the reader’s scroll position when returning to a linked transcript', async () => {
  targetBotLinkItem('session-1', 'answered')
  const view = render(<Transcript visible />)
  const scroll = screen.getByTestId('scroll')
  await waitFor(() => expect(scroll.scrollTop).toBe(120))
  await act(async () => {})
  scroll.scrollTop = 420
  fireEvent.scroll(scroll)
  view.rerender(<Transcript visible={false} />)
  view.rerender(<Transcript visible />)
  await act(async () => {})
  expect(scroll.scrollTop).toBe(420)
})

it('keeps the exact pending question selected and follows new output without a scroll jump', async () => {
  targetBotLinkItem('session-1', 'pending-1')
  const view = render(<Transcript visible pending output={1} />)
  await act(async () => {})
  expect(screen.getByText('Linked question')).toBeTruthy()
  view.rerender(<Transcript visible={false} pending output={1} />)
  view.rerender(<Transcript visible pending output={7} />)
  await act(async () => {})
  expect(screen.getByText('Following newest')).toBeTruthy()
  expect(screen.getByText('Linked question')).toBeTruthy()
  expect(screen.getByTestId('scroll').scrollTop).toBe(700)
})

it('does not replay a failed link jump when history arrives later', async () => {
  targetBotLinkItem('session-1', 'answered')
  const view = render(<Transcript visible rows={[]} />)
  await act(async () => {})
  view.rerender(<Transcript visible={false} rows={[]} />)
  view.rerender(<Transcript visible output={4} />)
  await act(async () => {})
  expect(screen.getByTestId('scroll').scrollTop).toBe(400)
})

it('returns to the newest output when a linked message is missing at the end of history', async () => {
  const view = render(<Transcript visible />)
  const scroll = screen.getByTestId('scroll')
  scroll.scrollTop = 420
  fireEvent.scroll(scroll)
  expect(screen.getByText('Reading earlier')).toBeTruthy()
  act(() => targetBotLinkItem('session-1', 'missing-item'))
  await waitFor(() => expect(screen.getByText('Following newest')).toBeTruthy())
  view.rerender(<Transcript visible output={7} />)
  await waitFor(() => expect(scroll.scrollTop).toBe(700))
  view.rerender(<Transcript visible={false} output={7} />)
  view.rerender(<Transcript visible output={8} />)
  await waitFor(() => expect(scroll.scrollTop).toBe(800))
})
