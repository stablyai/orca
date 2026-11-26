import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatOpenedPullRequest } from '../../../../../../shared/native-chat/tools/native-chat-opened-pull-requests'
import {
  nativeChatSlotJoinsActivityAbove,
  nativeChatSlotJoinsMessageAbove
} from './native-chat-activity-row-joins'
import { buildNativeChatTranscriptSlots } from './native-chat-transcript-slots'

let clock = 0
const row = (
  id: string,
  role: NativeChatMessage['role'],
  text: string,
  extra: Partial<NativeChatMessage> = {}
): NativeChatMessage => ({
  id,
  role,
  source: 'transcript',
  timestamp: (clock += 1),
  blocks: [{ type: 'text', text }],
  ...extra
})

const update = (id: string): NativeChatMessage =>
  row(id, 'user', 'Pushed the fix.', {
    from: {
      kind: 'agent',
      senders: [
        {
          party: { address: `term_${id}`, terminalHandle: `term_${id}`, orcaSessionId: null },
          name: 'Reviewer',
          relation: 'worker'
        }
      ],
      orchestration: { message: 'mail-notice', mailbox: 'term_b', dispatchId: null, messages: [] }
    }
  })

const pullRequest: NativeChatOpenedPullRequest = {
  provider: 'github',
  url: 'https://github.com/acme/widgets/pull/858',
  slug: { owner: 'acme', repo: 'widgets' },
  number: 858
}

function slotsOf(
  messages: NativeChatMessage[],
  openedPullRequests?: ReadonlyMap<string, readonly NativeChatOpenedPullRequest[]>,
  turnKeys = messages.map((message) => message.id)
) {
  return buildNativeChatTranscriptSlots({
    messages,
    turnKeys,
    liveTurnKey: undefined,
    receipts: new Map(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map(),
    openedPullRequests,
    expandedTurnKeys: new Set(),
    isWorking: false,
    lifecycleWorking: false
  })
}

const joins = (
  slots: ReturnType<typeof slotsOf>,
  index: number,
  markerKey: string | undefined = undefined
) =>
  nativeChatSlotJoinsActivityAbove({
    slot: slots[index]!,
    previous: slots[index - 1],
    timedRowsAfter: undefined,
    markerKey,
    leavesWhole: false
  })

describe('one-line rows across slots', () => {
  it('joins the row below the one the "New" line is drawn above, not that row itself', () => {
    const slots = slotsOf([update('a'), update('b'), update('c')])
    expect(joins(slots, 1, 'b')).toBe(false)
    expect(joins(slots, 2, 'b')).toBe(true)
  })

  it("joins the next one-line row to a turn's opened pull request line", () => {
    const messages = [
      row('ask', 'user', 'Open a PR for the fix.'),
      row('reply', 'assistant', 'Opened it.'),
      update('next')
    ]
    const slots = slotsOf(messages, new Map([['ask', [pullRequest]]]), ['ask', 'ask', 'next'])
    expect(slots.map((slot) => slot.kind === 'message' && slot.followsActivity === true)).toEqual([
      false,
      false,
      true
    ])
    expect(joins(slots, 2)).toBe(true)
  })
})

describe('messaging bubble grouping', () => {
  const pair = (role: 'user' | 'assistant') =>
    slotsOf([row('first', role, 'First message.'), row('second', role, 'Second message.')]).filter(
      (slot) => slot.kind === 'message'
    )
  const input = (role: 'user' | 'assistant' = 'user') => {
    const [previous, slot] = pair(role)
    return {
      slot: slot!,
      previous: previous!,
      timedRowsAfter: undefined,
      markerKey: undefined,
      leavesWhole: false
    }
  }

  it.each(['user', 'assistant'] as const)('joins consecutive %s text messages', (role) => {
    expect(nativeChatSlotJoinsMessageAbove(input(role))).toBe(true)
  })

  it('keeps tools and different senders apart', () => {
    const value = input()
    expect(
      nativeChatSlotJoinsMessageAbove({
        ...value,
        slot: { ...value.slot, message: { ...value.slot.message, role: 'assistant' } }
      })
    ).toBe(false)
    expect(
      nativeChatSlotJoinsMessageAbove({
        ...value,
        previous: {
          ...value.previous,
          message: {
            ...value.previous.message,
            blocks: [
              { type: 'text', text: 'Checking.' },
              {
                type: 'tool-call',
                name: 'read_file',
                callId: 'read',
                input: {},
                state: 'completed'
              }
            ]
          }
        }
      })
    ).toBe(false)
  })

  it('keeps the gap after a timed row and before the new-message marker', () => {
    const value = input()
    expect(
      nativeChatSlotJoinsMessageAbove({
        ...value,
        timedRowsAfter: new Map([['first', [{ key: 'approval', at: 1, node: null }]]])
      })
    ).toBe(false)
    expect(nativeChatSlotJoinsMessageAbove({ ...value, markerKey: 'second' })).toBe(false)
  })

  it('never stacks a leaving or continuing row’s negative margin', () => {
    const value = input('assistant')
    expect(nativeChatSlotJoinsMessageAbove({ ...value, leavesWhole: true })).toBe(false)
    expect(
      nativeChatSlotJoinsMessageAbove({ ...value, previous: { ...value.previous, leaving: 'row' } })
    ).toBe(false)
    expect(
      nativeChatSlotJoinsMessageAbove({
        ...value,
        previous: { ...value.previous, continuesTurn: true, endsResponse: false }
      })
    ).toBe(false)
    expect(
      nativeChatSlotJoinsMessageAbove({
        ...value,
        previous: { ...value.previous, continuesTurn: true, endsResponse: true }
      })
    ).toBe(true)
  })

  it('keeps sender cards, status bars and receipts outside message groups', () => {
    const value = input()
    const sender = update('sender').from
    const boundaries: Partial<typeof value.slot>[] = [
      { message: { ...value.slot.message, from: sender } },
      { status: { startedAt: 0, thinking: false, workedSeconds: 1 } },
      {
        receipt: {
          kind: 'question',
          question: 'Continue?',
          options: [],
          resolution: {
            state: 'resolved',
            selectedOptionId: 'yes',
            resolvedBy: null,
            resolvedAt: 1
          }
        }
      }
    ]
    for (const boundary of boundaries) {
      expect(
        nativeChatSlotJoinsMessageAbove({ ...value, slot: { ...value.slot, ...boundary } })
      ).toBe(false)
      expect(
        nativeChatSlotJoinsMessageAbove({ ...value, previous: { ...value.previous, ...boundary } })
      ).toBe(false)
    }
  })
})
