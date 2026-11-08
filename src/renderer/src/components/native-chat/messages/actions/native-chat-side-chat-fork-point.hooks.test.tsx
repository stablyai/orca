// @vitest-environment happy-dom
import { render } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type * as ForkOffer from '../../../../../../shared/native-chat/native-chat-fork-offer'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import {
  NativeChatForkContext,
  NativeChatSideChatForkPointContext
} from './native-chat-fork-context'
import type { NativeChatTranscriptSlotsInput } from '../../conversation/slots/native-chat-transcript-input'
import {
  useNativeChatSideChat,
  useNativeChatSideChatForkOffer,
  useNativeChatSideChatForkPointReport,
  type NativeChatSideChat
} from './use-native-chat-side-chat'
import type { NativeChatForkSurface } from './use-native-chat-fork'
import { useNativeChatTranscriptSlots } from '../../conversation/slots/use-native-chat-transcript-slots'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const offers = vi.hoisted(() => ({ checks: 0, lookups: 0 }))
vi.mock('../../../../../../shared/native-chat/native-chat-fork-offer', async (importOriginal) => {
  const actual = await importOriginal<typeof ForkOffer>()
  return {
    ...actual,
    nativeChatRowOffersFork: (...args: Parameters<typeof actual.nativeChatRowOffersFork>) => {
      offers.checks++
      return actual.nativeChatRowOffersFork(...args)
    }
  }
})

type Conversation = {
  messages: NativeChatMessage[]
  turnKeys: (string | undefined)[]
  working: boolean
}

function row(id: string, role: 'user' | 'assistant', sequence: number, text = id) {
  return {
    id,
    role,
    blocks: [{ type: 'text' as const, text }],
    timestamp: sequence,
    source: 'transcript' as const,
    journalPosition: { sequence, index: 0 }
  }
}

/** `size` finished turns, each a prompt and a reply, then a live turn streaming `text`. */
function conversation(size: number, text: string): Conversation {
  const messages: NativeChatMessage[] = []
  const turnKeys: (string | undefined)[] = []
  for (let turn = 0; turn < size; turn++) {
    messages.push(
      row(`ask-${turn}`, 'user', turn * 10 + 1),
      row(`reply-${turn}`, 'assistant', turn * 10 + 2)
    )
    turnKeys.push(`turn-${turn}`, `turn-${turn}`)
  }
  messages.push(
    row('ask-live', 'user', size * 10 + 1),
    row('live', 'assistant', size * 10 + 2, text)
  )
  turnKeys.push('turn-live', 'turn-live')
  return { messages, turnKeys, working: true }
}

function Transcript({ conversation: c }: { conversation: Conversation }): null {
  const latestTurnKey = c.turnKeys.findLast((key) => key !== undefined)
  const forkOffer = useNativeChatSideChatForkOffer(latestTurnKey)
  const input: Omit<NativeChatTranscriptSlotsInput, 'liveReasoningId'> = {
    messages: c.messages,
    turnKeys: c.turnKeys,
    liveTurnKey: c.working ? latestTurnKey : undefined,
    receipts: EMPTY_RECEIPTS,
    turnStatuses: NO_STATUSES,
    turnDiffs: EMPTY_DIFFS,
    expandedTurnKeys: EMPTY_KEYS,
    isWorking: c.working,
    lifecycleWorking: false,
    ...(forkOffer ? { forkOffer } : {})
  }
  const { forkPoint } = useNativeChatTranscriptSlots({
    ...input,
    scopeKey: 'side-chat-fork-test',
    line: LINE
  })
  useNativeChatSideChatForkPointReport(forkPoint)
  return null
}
const EMPTY_RECEIPTS = new Map()
const NO_STATUSES = { active: null, completedByTurn: {} }
const EMPTY_DIFFS = new Map()
const EMPTY_KEYS = new Set<string>()
const LINE = { draws: false, thinking: false }

/** Every eligibility decision, in any search, asks this set; count those asks. */
class CountedSet extends Set<string> {
  override has(id: string): boolean {
    offers.lookups++
    return super.has(id)
  }
}

const request = vi.fn()
function forkSurface(
  ids: Iterable<string>,
  floor = 0,
  known = true,
  mode: 'checkpoint' | 'tip' = 'checkpoint'
): NativeChatForkSurface {
  const rowAction = {
    support: known ? ({ kind: 'known', fork: mode } as const) : ({ kind: 'unknown' } as const),
    pendingItemId: null,
    request
  }
  return {
    ...rowAction,
    contextFloorSequence: floor,
    forkableItemIds: new CountedSet(ids),
    rowAction
  }
}

let sideChat: NativeChatSideChat | undefined
function Pane(props: {
  fork: NativeChatForkSurface
  conversation: Conversation
  listening?: boolean
  drawn?: boolean
}): React.JSX.Element {
  sideChat = useNativeChatSideChat(props.fork)
  return (
    <NativeChatForkContext.Provider value={props.fork}>
      <NativeChatSideChatForkPointContext.Provider
        value={props.listening === false ? undefined : sideChat?.reportForkPoint}
      >
        {props.drawn === false ? null : <Transcript conversation={props.conversation} />}
      </NativeChatSideChatForkPointContext.Provider>
    </NativeChatForkContext.Provider>
  )
}

const allReplies = (size: number) => [
  ...Array.from({ length: size }, (_, i) => `reply-${i}`),
  'live'
]

beforeEach(() => {
  request
    .mockReset()
    .mockResolvedValue({ chat: { sessionId: 's', executionHostId: 'local' }, question: 'sent' })
  sideChat = undefined
})

it('follows forkability, the /clear floor and turn attribution', async () => {
  const c = conversation(2, 'a')
  const view = render(<Pane fork={forkSurface(['reply-0'])} conversation={c} />)
  await act(() => sideChat!.open('q'))
  expect(request).toHaveBeenLastCalledWith('reply-0', { question: 'q' })

  view.rerender(<Pane fork={forkSurface(allReplies(2))} conversation={c} />)
  await act(() => sideChat!.open('q'))
  expect(request).toHaveBeenLastCalledWith('reply-1', { question: 'q' })

  // Everything above a /clear is out of the agent's context.
  view.rerender(<Pane fork={forkSurface(allReplies(2), 100)} conversation={c} />)
  expect(sideChat!.notReadyReason).not.toBeNull()

  // At a tip-only agent, a response outside any turn, drawn last, hides nothing before it.
  const unowned = {
    messages: [...c.messages, row('note', 'assistant', 99)],
    turnKeys: [...c.turnKeys, undefined],
    working: false
  }
  view.rerender(
    <Pane fork={forkSurface([...allReplies(2), 'note'], 0, true, 'tip')} conversation={unowned} />
  )
  await act(() => sideChat!.open('q'))
  expect(request).toHaveBeenLastCalledWith('live', { question: 'q' })
})

it('has nothing to fork once a rewind empties the conversation', async () => {
  const fork = forkSurface(allReplies(2))
  const view = render(<Pane fork={fork} conversation={conversation(2, 'a')} />)
  const empty = { messages: [], turnKeys: [], working: false }

  view.rerender(<Pane fork={fork} conversation={empty} />)
  const outcome = await act(() => sideChat!.open('q'))

  expect(outcome).toHaveProperty('refused')
  expect(request).not.toHaveBeenCalled()
})

it('forgets the fork point while no transcript is drawn, and takes the next one', async () => {
  const fork = forkSurface(allReplies(2))
  const c = conversation(2, 'a')
  const view = render(<Pane fork={fork} conversation={c} />)

  view.rerender(<Pane fork={fork} conversation={c} drawn={false} />)
  expect(await act(() => sideChat!.open('q'))).toHaveProperty('refused')
  expect(request).not.toHaveBeenCalled()

  view.rerender(<Pane fork={fork} conversation={c} />)
  await act(() => sideChat!.open('q'))
  expect(request).toHaveBeenCalledWith('reply-1', { question: 'q' })
})
