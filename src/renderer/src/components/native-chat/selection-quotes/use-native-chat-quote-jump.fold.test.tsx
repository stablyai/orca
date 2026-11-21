// @vitest-environment happy-dom
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const shown = vi.hoisted(() => vi.fn())
vi.mock('./native-chat-quote-highlight', () => ({ showQuotedText: shown }))

import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { buildNativeChatTranscriptSlots } from '../conversation/slots/native-chat-transcript-slots'
import { nativeChatFoldedTurnOf } from '../conversation/slots/native-chat-transcript-slot-selection'
import {
  useNativeChatNavigation,
  useNativeChatNavigationRequest
} from '../viewport/navigation/use-native-chat-transcript-navigation'
import { jumpToQuoteSource, rememberNativeChatQuoteSource } from './native-chat-quote-sources'
import type { NativeChatQuoteJump } from './use-native-chat-quote-jump'

afterEach(() => {
  cleanup()
  shown.mockReset()
  localStorage.clear()
})

const none = () => {}
const CHAT = 'claude:session-1'
const at = (id: string, role: NativeChatMessage['role'], text: string): NativeChatMessage => ({
  id,
  role,
  timestamp: 1,
  source: 'transcript',
  blocks: [{ type: 'text', text }]
})
const tool = (id: string): NativeChatMessage => ({
  ...at(id, 'assistant', ''),
  blocks: [{ type: 'tool-call', name: 'Bash', callId: id, input: {} }]
})

/** One settled turn, drawn by the real slot builder: only drawn rows carry the quote source. */
function Transcript({
  messages,
  onJump,
  loadEarlier
}: {
  messages: NativeChatMessage[]
  onJump: (jump: NativeChatQuoteJump) => void
  loadEarlier: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const turnKeys = useMemo(() => messages.map(() => 'turn-1'), [messages])
  const slots = useMemo(
    () =>
      buildNativeChatTranscriptSlots({
        messages,
        turnKeys,
        liveTurnKey: undefined,
        receipts: new Map(),
        turnStatuses: {
          active: null,
          completedByTurn: { 'turn-1': { startedAt: 0, thinking: false, workedSeconds: 9 } }
        },
        turnDiffs: new Map(),
        expandedTurnKeys: expanded,
        isWorking: false,
        lifecycleWorking: false
      }),
    [expanded, messages, turnKeys]
  )
  const request = useNativeChatNavigationRequest(slots)
  // As the message list does.
  const unfoldTurnOf = useCallback(
    (id: string) => {
      const turnKey = nativeChatFoldedTurnOf(slots, messages, turnKeys, expanded, id)
      if (turnKey !== undefined) {
        setExpanded((current) => new Set(current).add(turnKey))
      }
      return turnKey !== undefined
    },
    [expanded, messages, slots, turnKeys]
  )
  const { jumpToQuote } = useNativeChatNavigation({
    request,
    rail: { items: [], onActivate: none },
    slots,
    conversation: [],
    subagentRows: new Map(),
    roster: undefined,
    journalItems: [],
    subagentId: null,
    sessionKey: CHAT,
    sessionId: 'session-1',
    isVisible: true,
    loadEarlier: async () => {
      loadEarlier()
      return 'exhausted'
    },
    holdHistory: none,
    releaseHistory: none,
    scrollRef,
    scrollMessageToTop: none,
    readerLeavesEnd: none,
    scrollToBottom: none,
    unfoldTurnOf
  })
  // The test reads the jump after the commit, not during render.
  useLayoutEffect(() => {
    onJump(jumpToQuote)
  })
  return (
    <div ref={scrollRef}>
      {slots.map((slot, index) => (
        <div key={index} data-index={index}>
          {slot.kind === 'message' && slot.drawsMessage ? (
            <div data-native-chat-quote-source={slot.message.id}>The quoted text.</div>
          ) : null}
        </div>
      ))}
    </div>
  )
}

function clickChip(messages: NativeChatMessage[]) {
  let jumpToMessage: NativeChatQuoteJump | null = null
  const loadEarlier = vi.fn()
  const view = render(
    <Transcript
      messages={messages}
      loadEarlier={loadEarlier}
      onJump={(jump) => (jumpToMessage = jump)}
    />
  )
  rememberNativeChatQuoteSource('quoted text', { messageId: 'quoted', place: null, chat: CHAT })
  const notifyMissing = vi.fn()
  act(() => {
    jumpToQuoteSource('quoted text', { jumpToMessage, openFile: null, notifyMissing })
  })
  return { view, notifyMissing, loadEarlier }
}

// The quoted reply is followed by work, so the settled turn folds it behind its answer.
const turn = [
  at('ask', 'user', 'Cut the nightly'),
  at('quoted', 'assistant', 'Nightly is ready.'),
  tool('call-1'),
  at('answer', 'assistant', 'Done.')
]

it('expands the settled turn that folds the quoted reply, and shows the quote in it', async () => {
  const { view, notifyMissing, loadEarlier } = clickChip(turn)
  await waitFor(() => expect(shown).toHaveBeenCalledOnce())
  expect(shown).toHaveBeenCalledWith(
    view.container.querySelector('[data-native-chat-quote-source="quoted"]'),
    'quoted text',
    null
  )
  expect(notifyMissing).not.toHaveBeenCalled()
  // The reply is loaded: no older history is read.
  expect(loadEarlier).not.toHaveBeenCalled()
})

it('expands the turn when the folded reply is its first row, which keeps only the turn bar', async () => {
  // No user bubble: the turn's bar sits on the folded reply's slot, which draws no text.
  const { notifyMissing, loadEarlier } = clickChip(turn.slice(1))
  await waitFor(() => expect(shown).toHaveBeenCalledOnce())
  expect(notifyMissing).not.toHaveBeenCalled()
  expect(loadEarlier).not.toHaveBeenCalled()
})
