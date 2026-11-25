import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatTranscriptSlotsInput } from './native-chat-transcript-input'
import { buildNativeChatTranscript } from './native-chat-transcript-slots'
import { nativeChatTurnsHeldOpen, type NativeChatTranscriptBuild } from './native-chat-held-open-turns'

const message = (id: string, role: 'user' | 'assistant', blocks: NativeChatMessage['blocks']) =>
  ({ id, role, source: 'transcript', timestamp: null, blocks }) satisfies NativeChatMessage

const command = (index: number) =>
  message(`call-${index}`, 'assistant', [
    {
      type: 'tool-call',
      name: 'shell',
      callId: `c${index}`,
      input: { command: `echo ${index}` },
      state: 'completed'
    },
    { type: 'tool-result', callId: `c${index}`, output: `out ${index}` }
  ])

function build(
  messages: NativeChatMessage[],
  turnKeys: (string | undefined)[],
  { settled, expanded = new Set<string>() }: { settled: boolean; expanded?: ReadonlySet<string> }
): NativeChatTranscriptBuild {
  const input: NativeChatTranscriptSlotsInput = {
    messages,
    turnKeys,
    liveTurnKey: undefined,
    receipts: new Map(),
    turnStatuses: {
      active: null,
      completedByTurn: settled ? { p: { startedAt: 0, thinking: false, workedSeconds: 8 } } : {}
    },
    turnDiffs: new Map(),
    expandedTurnKeys: expanded,
    isWorking: false,
    lifecycleWorking: false
  }
  return { messages, turnKeys, slots: buildNativeChatTranscript(input).slots }
}

const drawn = ({ slots }: NativeChatTranscriptBuild) =>
  slots.flatMap((slot) =>
    slot.kind === 'message' && slot.drawsMessage && !slot.folded
      ? (slot.workRun ?? [slot.message]).map((member) => member.id)
      : []
  )

// The window held a run's tail without its prompt; the older page brings the prompt and the
// turn's settled status, which folds the turn's work.
const answer = message('answer', 'assistant', [{ type: 'text', text: 'Done.' }])
const held = [command(2), command(3), answer]
const loaded = [message('prompt', 'user', [{ type: 'text', text: 'Do it' }]), command(0), command(1), ...held]

it('keeps open the turn whose work the reader saw when its prompt arrives', () => {
  const before = build(held, held.map(() => undefined), { settled: false })
  expect(drawn(before)).toEqual(expect.arrayContaining(['call-2', 'call-3']))

  const after = build(loaded, loaded.map(() => 'p'), { settled: true })
  expect(drawn(after)).not.toContain('call-3')
  const turns = nativeChatTurnsHeldOpen(before, after, new Set())
  expect([...turns]).toEqual(['p'])

  const open = build(loaded, loaded.map(() => 'p'), { settled: true, expanded: turns })
  expect(drawn(open)).toEqual(expect.arrayContaining(['call-0', 'call-1', 'call-2', 'call-3']))
})

it('lets a turn fold when it settles without older rows arriving', () => {
  const live = build(loaded, loaded.map(() => 'p'), { settled: false })
  const settled = build(loaded, loaded.map(() => 'p'), { settled: true })

  expect(nativeChatTurnsHeldOpen(live, settled, new Set()).size).toBe(0)
})

it('holds nothing the reader already opened or that did not fold', () => {
  const before = build(held, held.map(() => undefined), { settled: false })
  const after = build(loaded, loaded.map(() => 'p'), { settled: true, expanded: new Set(['p']) })
  expect(nativeChatTurnsHeldOpen(before, after, new Set(['p'])).size).toBe(0)

  const unsettled = build(loaded, loaded.map(() => 'p'), { settled: false })
  expect(nativeChatTurnsHeldOpen(before, unsettled, new Set()).size).toBe(0)
})
