// @vitest-environment happy-dom
// Older history pages must not close or remount output a reader already opened.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  NativeChatMessage,
  NativeChatToolCallBlock,
  NativeChatToolResultBlock
} from '../../../../../../shared/native-chat/native-chat-types'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from '../../messages/disclosure/native-chat-disclosure-store'
import {
  NativeChatTranscriptRow,
  type NativeChatTranscriptRowContext
} from '../../messages/rows/NativeChatTranscriptRow'
import { useNativeChatTranscriptSlots } from './use-native-chat-transcript-slots'
import { nativeChatSlotKey } from './native-chat-transcript-slot-selection'

vi.mock('../../tools/diffs/NativeChatDiffCard', () => ({ NativeChatDiffCard: () => null }))
vi.mock('../../tools/diffs/NativeChatDiffView', () => ({ NativeChatDiffView: () => null }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function shellCall(callId: string, command: string): NativeChatToolCallBlock {
  return { type: 'tool-call', name: 'shell', callId, input: { command }, state: 'completed' }
}

function shellResult(callId: string, output: string): NativeChatToolResultBlock {
  return { type: 'tool-result', callId, output }
}

/** A command's own row; a one-command run's header also names the command. */
function commandButton(command: string): HTMLElement {
  const button = screen.getAllByRole('button', { name: new RegExp(command) })[0]
  if (!button) {
    throw new Error(`Missing command: ${command}`)
  }
  return button
}

const rowContext: NativeChatTranscriptRowContext = {
  expandSignal: false,
  revealedDiff: null,
  taskListPredecessors: new Map(),
  expandedTurnIds: new Set(),
  onToggleExpandedTurn: () => {},
  onScrollMessageToTop: () => {},
  onRevealDiff: () => {},
  readerAtEnd: () => true
}

function HistoryRun({ messages }: { messages: NativeChatMessage[] }): React.JSX.Element {
  const disclosures = useNativeChatDisclosures()
  const { slots } = useNativeChatTranscriptSlots({
    messages,
    turnKeys: messages.map(() => undefined),
    liveTurnKey: undefined,
    receipts: new Map(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map(),
    expandedTurnKeys: new Set(),
    isWorking: false,
    lifecycleWorking: false,
    line: { tailRow: null, thinking: false }
  })
  return (
    <NativeChatDisclosureContext.Provider value={disclosures}>
      {slots.map((slot) => (
        <NativeChatTranscriptRow key={nativeChatSlotKey(slot)} slot={slot} context={rowContext} />
      ))}
    </NativeChatDisclosureContext.Provider>
  )
}

describe('older history prepend disclosure identity', () => {
  const message = (id: string, command: string, output: string): NativeChatMessage => ({
    id,
    role: 'assistant',
    source: 'transcript',
    timestamp: null,
    blocks: [shellCall(id, command), shellResult(id, output)]
  })

  it.each(['single', 'grouped'])(
    'keeps opened output when an older page extends a %s work run',
    (kind) => {
      const kept = message('kept', 'echo kept', 'KEPT_OUTPUT')
      const newer = message('newer', 'echo newer', 'NEWER_OUTPUT')
      const held = kind === 'single' ? [kept] : [kept, newer]
      const { rerender } = render(<HistoryRun messages={held} />)
      fireEvent.click(screen.getByRole('button', { expanded: false }))
      const outputButton = commandButton('Ran echo kept')
      fireEvent.click(outputButton)
      expect(screen.getByText('KEPT_OUTPUT')).toBeTruthy()
      rerender(<HistoryRun messages={[message('older', 'echo older', 'OLDER_OUTPUT'), ...held]} />)
      expect(commandButton('Ran echo kept')).toBe(outputButton)
      expect(commandButton('Ran echo kept').getAttribute('aria-expanded')).toBe('true')
      expect(screen.getByText('KEPT_OUTPUT')).toBeTruthy()
    }
  )

  it('keeps the surviving output open when a prepended work run splits at new prose', () => {
    const kept = message('kept', 'echo kept', 'KEPT_OUTPUT')
    const newer = message('newer', 'echo newer', 'NEWER_OUTPUT')
    const older = message('older', 'echo older', 'OLDER_OUTPUT')
    const boundary = message('boundary', 'echo boundary', 'BOUNDARY_OUTPUT')
    const { rerender } = render(<HistoryRun messages={[kept, newer]} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    const outputButton = commandButton('Ran echo kept')
    fireEvent.click(outputButton)
    rerender(<HistoryRun messages={[older, boundary, kept, newer]} />)
    expect(screen.getByText('KEPT_OUTPUT')).toBeTruthy()
    rerender(
      <HistoryRun
        messages={[
          older,
          { ...boundary, blocks: [{ type: 'text', text: 'A new prose boundary' }] },
          kept,
          newer
        ]}
      />
    )
    expect(screen.getByText('A new prose boundary')).toBeTruthy()
    expect(commandButton('Ran echo kept')).toBe(outputButton)
    expect(commandButton('Ran echo kept').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('KEPT_OUTPUT')).toBeTruthy()
  })

  it('keeps the opened run when its calls regroup under an older message', () => {
    // A window cut leaves the run's later calls in a message of their own; the older page then
    // reads them back as part of the message that holds the agent's words before them.
    const calls = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, offset) => [
        shellCall(`run-${from + offset}`, `echo step-${from + offset}`),
        shellResult(`run-${from + offset}`, `STEP_${from + offset}_OUTPUT`)
      ]).flat()
    const cut: NativeChatMessage = {
      id: 'cut-head',
      role: 'assistant',
      source: 'transcript',
      timestamp: null,
      blocks: calls(2, 4)
    }
    const { rerender } = render(<HistoryRun messages={[cut]} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    const outputButton = commandButton('Ran echo step-3')
    fireEvent.click(outputButton)
    expect(screen.getByText('STEP_3_OUTPUT')).toBeTruthy()

    const regrouped: NativeChatMessage = {
      id: 'older-words',
      role: 'assistant',
      source: 'transcript',
      timestamp: null,
      blocks: [{ type: 'text', text: 'Looking at the logs first.' }, ...calls(0, 4)]
    }
    rerender(<HistoryRun messages={[regrouped]} />)

    expect(screen.getByText('Looking at the logs first.')).toBeTruthy()
    expect(commandButton('Ran echo step-3')).toBe(outputButton)
    expect(outputButton.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('STEP_3_OUTPUT')).toBeTruthy()
  })
})
