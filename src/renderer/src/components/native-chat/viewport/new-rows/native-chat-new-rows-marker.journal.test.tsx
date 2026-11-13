// @vitest-environment happy-dom

// The queued-run rule, driven from journal items through the desktop projection, turn membership,
// slots and the waiting split, the way NativeChatMessageList feeds the marker.

import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnItem
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { agentJournalSubmissionKey } from '../../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { owesStructuredAgentSessionWork } from '../../../../../../shared/agent-session/view/structured-agent-session-owed-work'
import { withNativeChatCutTurnNotices } from '../../../../../../shared/native-chat/transcript/native-chat-cut-turn-notice'
import { nativeChatTurnMembership } from '../../../../../../shared/native-chat/transcript/native-chat-turn-membership'
import { nativeChatRowsInDrawOrder } from '../../../../../../shared/native-chat/transcript/native-chat-turn-grouping'
import { projectStructuredAgentSessionMessages } from '../../conversation/projection/structured-agent-session-message-projection'
import { buildNativeChatTranscriptSlots } from '../../conversation/slots/native-chat-transcript-slots'
import { splitNativeChatSlotsWaitingBehindLiveTurn } from '../../conversation/slots/native-chat-transcript-slot-selection'
import { useNativeChatNewRowsMarker } from './native-chat-new-rows-marker'

const THREAD: AgentJournalTurnScope = { kind: 'thread' }
const inTurn = (turnItemId: string): AgentJournalTurnScope => ({ kind: 'turn', turnItemId })

function item(
  itemId: string,
  sequence: number,
  body: AgentJournalRenderItem['body'],
  turnScope?: AgentJournalTurnScope
): AgentJournalRenderItem {
  const row: AgentJournalRenderItem = { itemId, sequence, revision: 1, observedAt: sequence, body }
  return turnScope ? { ...row, turnScope } : row
}

const message = (
  id: string,
  sequence: number,
  role: 'user' | 'assistant',
  scope: AgentJournalTurnScope
): AgentJournalRenderItem =>
  item(id, sequence, { kind: 'message', role, blocks: [{ type: 'text', text: id }] }, scope)

/** A turn record; one that names itself as its opener was opened by the provider, not a send. */
function turn(
  id: string,
  sequence: number,
  state: 'running' | 'completed',
  opener = id
): AgentJournalRenderItem {
  const body: AgentJournalTurnItem = {
    kind: 'turn',
    turnId: id,
    state,
    userItemId: opener,
    startedAt: sequence
  }
  return item(id, sequence, state === 'completed' ? { ...body, outcome: 'success' } : body, THREAD)
}

const HELD = agentJournalSubmissionKey('held')
/** Accepted by the host and recorded, but not yet handed to the agent. */
const held: AgentJournalSubmission = {
  clientMessageId: 'held',
  fence: 1,
  payloadFingerprint: 'held',
  dispatchState: 'pending',
  providerItemId: null,
  reason: null,
  submittedAt: 4,
  resolvedAt: null,
  handoverRecorded: true
}
const handedOver = (at: number): AgentJournalSubmission => ({
  ...held,
  dispatchState: 'accepted',
  providerItemId: HELD,
  resolvedAt: at,
  handedOverAt: at
})

/** What NativeChatMessageList hands the marker for these journal items. */
function pane(items: AgentJournalRenderItem[], submissions: AgentJournalSubmission[]) {
  const working = owesStructuredAgentSessionWork(items, submissions)
  const messages = projectStructuredAgentSessionMessages(
    withNativeChatCutTurnNotices(items),
    [],
    submissions
  )
  const membership = nativeChatTurnMembership(messages, { items, submissions })
  const slots = buildNativeChatTranscriptSlots({
    messages: nativeChatRowsInDrawOrder(messages, membership.drawOrder),
    turnKeys: nativeChatRowsInDrawOrder(membership.turnKeys, membership.drawOrder),
    liveTurnKey: membership.liveTurnKey,
    unresolvedRowIds: membership.unresolvedRowIds,
    receipts: new Map(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map(),
    expandedTurnKeys: new Set(),
    isWorking: working,
    lifecycleWorking: working
  })
  return {
    ...splitNativeChatSlotsWaitingBehindLiveTurn(slots, items, false, submissions, { working }),
    host: { items }
  }
}

type Pane = ReturnType<typeof pane>

function leaveAndReturn(left: Pane, back: Pane) {
  const view = renderHook(
    ({ at, showing }: { at: Pane; showing: boolean }) =>
      useNativeChatNewRowsMarker(at.slots, at.waitingSlots, showing, at.host),
    { initialProps: { at: left, showing: true } }
  )
  view.rerender({ at: left, showing: false })
  view.rerender({ at: back, showing: true })
  return view
}

describe('the New line for a send that ran while the reader was away, from the journal', () => {
  let hasFocus: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  })
  afterEach(() => hasFocus.mockRestore())

  const EARLIER = [
    message('old-prompt', 1, 'user', inTurn('old-turn')),
    turn('old-turn', 2, 'completed', 'old-prompt'),
    message('old-answer', 3, 'assistant', inTurn('old-turn'))
  ]

  it('draws when a held send ran behind a turn the provider opened and drew nothing in', () => {
    const left = pane(
      [...EARLIER, turn('resumed', 4, 'running'), message(HELD, 5, 'user', THREAD)],
      [held]
    )
    const back = pane(
      [
        ...EARLIER,
        turn('resumed', 4, 'completed'),
        message(HELD, 6, 'user', inTurn('next')),
        turn('next', 7, 'completed', HELD),
        message('short-answer', 8, 'assistant', inTurn('next'))
      ],
      [handedOver(6)]
    )
    expect(leaveAndReturn(left, back).result.current.marker).toMatchObject({ look: 'line' })
  })

  it("weighs a new chat's first answer by height, its send held before any turn opened", () => {
    const left = pane([message(HELD, 1, 'user', THREAD)], [held])
    const back = pane(
      [
        message(HELD, 2, 'user', inTurn('first')),
        turn('first', 3, 'completed', HELD),
        message('first-answer', 4, 'assistant', inTurn('first'))
      ],
      [handedOver(2)]
    )
    expect(leaveAndReturn(left, back).result.current.marker).toMatchObject({ look: 'measure' })
  })
})
