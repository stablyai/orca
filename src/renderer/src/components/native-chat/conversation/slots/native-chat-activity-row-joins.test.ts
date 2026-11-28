import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatOpenedPullRequest } from '../../../../../../shared/native-chat/tools/native-chat-opened-pull-requests'
import { nativeChatSlotJoinsActivityAbove } from './native-chat-activity-row-joins'
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
