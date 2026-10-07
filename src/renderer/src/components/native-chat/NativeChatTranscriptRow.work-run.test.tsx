// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  NativeChatTranscriptRow,
  type NativeChatTranscriptRowContext
} from './NativeChatTranscriptRow'
import {
  buildNativeChatTranscriptSlots,
  type NativeChatTranscriptSlot
} from './native-chat-transcript-slots'

afterEach(cleanup)

const prompt: NativeChatMessage = {
  id: 'u',
  role: 'user',
  blocks: [{ type: 'text', text: 'go' }],
  timestamp: 1,
  source: 'transcript'
}
const edit: NativeChatMessage = {
  id: 'edit-1',
  role: 'assistant',
  blocks: [
    { type: 'tool-call', name: 'Diff', input: { path: 'a.ts' }, state: 'completed' },
    { type: 'tool-result', output: '@@ -1 +1 @@\n-old\n+new' }
  ],
  timestamp: 2,
  source: 'transcript'
}
const thought: NativeChatMessage = {
  id: 'r-1',
  role: 'reasoning',
  blocks: [{ type: 'text', text: 'Now run the tests.' }],
  timestamp: 3,
  completedAt: 4,
  state: 'completed',
  source: 'transcript'
}
const command: NativeChatMessage = {
  id: 'b',
  role: 'assistant',
  blocks: [{ type: 'tool-call', name: 'Bash', input: { command: 'pnpm test' }, state: 'running' }],
  timestamp: 5,
  source: 'transcript'
}

/** The slot drawing `edit-1`, as the live transcript builds it. */
function editSlot(messages: NativeChatMessage[]): NativeChatTranscriptSlot {
  const slots = buildNativeChatTranscriptSlots({
    messages,
    turnKeys: messages.map(() => 'u'),
    liveTurnKey: 'u',
    receipts: new Map(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map(),
    expandedTurnKeys: new Set(),
    isWorking: true,
    lifecycleWorking: false
  })
  return slots.find((slot) => slot.kind === 'message' && slot.message.id === 'edit-1')!
}

describe('a transcript row turning into a work run', () => {
  // A row that remounted as a run re-ran its revealed diff card's reveal and scrolled the reader.
  it('keeps a revealed diff card mounted, so its reveal does not fire again', () => {
    const onScrollMessageToTop = vi.fn()
    const context: NativeChatTranscriptRowContext = {
      expandSignal: false,
      revealedDiff: { messageId: 'edit-1', editKey: 'Diff:0', fileIndex: 0, requestId: 1 },
      taskListPredecessors: new Map(),
      expandedTurnIds: new Set(),
      allowFileUriLinks: false,
      onToggleExpandedTurn: () => {},
      subagentDisclosure: { setSectionOpen: () => {}, setRosterOpen: () => {} },
      onScrollMessageToTop,
      onRevealDiff: () => {}
    }
    const lone = editSlot([prompt, edit])
    expect(lone.kind === 'message' && lone.workRun).toBeFalsy()
    const { rerender } = render(<NativeChatTranscriptRow slot={lone} context={context} />)
    expect(onScrollMessageToTop).toHaveBeenCalledTimes(1)
    const card = screen.getByText('old').closest('div')!

    const run = editSlot([prompt, edit, thought, command])
    expect(run.kind === 'message' && run.workRun?.map((member) => member.id)).toEqual([
      'edit-1',
      'r-1',
      'b'
    ])
    rerender(<NativeChatTranscriptRow slot={run} context={context} />)
    expect(screen.getByRole('button', { name: /Thought/ })).toBeDefined()
    expect(card.isConnected).toBe(true)
    expect(onScrollMessageToTop).toHaveBeenCalledTimes(1)
  })
})
