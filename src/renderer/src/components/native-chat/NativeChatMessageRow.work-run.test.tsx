// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { render } from './native-chat-tooltip-test-harness'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Why: these fixtures have neither inline visual owners nor sender navigation.
const unusedChatLeaves = vi.hoisted(() => ({
  inlineVisual: vi.fn(() => {
    throw new Error('Unexpected inline visual in transcript fixture')
  }),
  openSender: vi.fn(() => {
    throw new Error('Unexpected sender navigation in transcript fixture')
  })
}))
vi.mock('./NativeChatInlineVisual', () => ({
  NativeChatInlineVisual: unusedChatLeaves.inlineVisual
}))
vi.mock('@/lib/open-agent-message-sender', () => ({
  openAgentMessageSender: unusedChatLeaves.openSender
}))
afterEach(() => {
  expect(unusedChatLeaves.inlineVisual).not.toHaveBeenCalled()
  expect(unusedChatLeaves.openSender).not.toHaveBeenCalled()
})
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { MessageRow } from './NativeChatMessageRow'
import {
  buildNativeChatTranscriptSlots,
  nativeChatSlotIndexOf,
  type NativeChatMessageSlot
} from './native-chat-transcript-slots'
import {
  APPROVED_REVIEW,
  approvalReviewMessage
} from '../../../../shared/native-chat-activity.test-fixture'
import { openToolRunMembers } from './native-chat-tool-run-members-test-support'

afterEach(() => {
  cleanup()
})

function command(id: string, cmd: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [
      { type: 'tool-call', name: 'Bash', input: { command: cmd }, state: 'completed', callId: id },
      { type: 'tool-result', output: 'ok', callId: id }
    ],
    timestamp: 1,
    source: 'transcript'
  }
}

describe('successful automatic review activity', () => {
  it.each(['review-first', 'tool-first'])(
    'retains consecutive review and tool activity behind one closed row: %s',
    (order) => {
      const review = approvalReviewMessage('review')
      const action = command('action', 'pnpm test')
      const members = order === 'review-first' ? [review, action] : [action, review]
      const slots = activitySlots(members)
      expect(slots).toHaveLength(1)
      expect(slots[0]?.workRun).toEqual(members)
      expect(nativeChatSlotIndexOf(slots, 'action')).toBe(0)
      expect(nativeChatSlotIndexOf(slots, 'review')).toBe(0)
      const { container } = render(
        <MessageRow
          message={members[0]!}
          workRun={slots[0]?.workRun}
          expandSignal={false}
          onScrollMessageToTop={() => {}}
        />
      )
      const header = container.querySelector('[data-native-chat-tool-run-state]')!
      expect(header).toHaveAttribute('aria-expanded', 'false')
      expect(container.querySelectorAll('[data-native-chat-tool-run-state]')).toHaveLength(1)
      expect(screen.queryByText(APPROVED_REVIEW)).toBeNull()
      expect(screen.queryByText('ok')).toBeNull()
      fireEvent.click(header)
      expect(screen.getByText(APPROVED_REVIEW)).toBeVisible()
      expect(
        container.querySelector('[data-native-chat-activity-message-id="review"]')
      ).not.toBeNull()
      openToolRunMembers()
      expect(screen.getByText('ok')).toBeVisible()
    }
  )

  it('groups successive reviews even before their tool arrives', () => {
    const members = [
      approvalReviewMessage('review-a'),
      approvalReviewMessage('review-b', APPROVED_REVIEW.replace('local check', 'file read'))
    ]
    const slots = activitySlots(members)
    const { container } = render(
      <MessageRow
        message={members[0]!}
        workRun={slots[0]?.workRun}
        expandSignal={false}
        onScrollMessageToTop={() => {}}
      />
    )
    const header = container.querySelector('[data-native-chat-tool-run-state]')!
    expect(header).toHaveTextContent('Activity')
    expect(container.querySelectorAll('button')).toHaveLength(1)
    fireEvent.click(header)
    expect(screen.getByText(APPROVED_REVIEW)).toBeVisible()
    expect(screen.getByText(APPROVED_REVIEW.replace('local check', 'file read'))).toBeVisible()
  })
})

function activitySlots(messages: NativeChatMessage[]): NativeChatMessageSlot[] {
  return buildNativeChatTranscriptSlots({
    messages,
    turnKeys: messages.map(() => 'turn'),
    liveTurnKey: undefined,
    receipts: new Map(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map(),
    expandedTurnKeys: new Set(),
    isWorking: false,
    lifecycleWorking: false
  }).filter((slot): slot is NativeChatMessageSlot => slot.kind === 'message')
}
