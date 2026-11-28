import { useState } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatTurnStatus } from '../../../../../../shared/native-chat/transcript/turns/native-chat-turn-status'
import type { NativeChatTranscriptRowContext } from '../../messages/rows/NativeChatTranscriptRow'
import { buildNativeChatTranscriptSlots } from '../slots/native-chat-transcript-slots'
import { NativeChatTranscriptRowStack } from '../../viewport/virtualization/NativeChatTranscriptItems'
import { NativeChatTurnActivityLine } from '../../messages/reasoning/NativeChatTurnActivityLine'

// Anchored to now so the live clock reads the same in every shot: 6m 14s of work, then the
// follow-up 16s ago.
const now = Date.now()
const start = now - 390_000
const at = (seconds: number): number => start + seconds * 1000

const row = (
  id: string,
  role: NativeChatMessage['role'],
  seconds: number,
  blocks: NativeChatMessage['blocks'],
  extra: Partial<NativeChatMessage> = {}
): NativeChatMessage => ({
  id,
  role,
  source: 'transcript',
  timestamp: at(seconds),
  blocks,
  ...extra
})

const call = (id: string, command: string): NativeChatMessage['blocks'][number] => ({
  type: 'tool-call',
  callId: id,
  name: 'Bash',
  input: { command }
})
const result = (id: string): NativeChatMessage['blocks'][number] => ({
  type: 'tool-result',
  callId: id,
  output: 'ok'
})

const ask = row('ask', 'user', 0, [
  { type: 'text', text: 'The release scan took 6 hours and is still not done. Find out why.' }
])
const followUp = row('follow-up', 'user', 374, [
  { type: 'text', text: 'Debug deeply and do a deep analysis based on all relevant transcripts.' }
])
const beforeFollowUp = [
  row('read-1', 'assistant', 5, [call('c1', 'orca orchestration check --json')]),
  row('read-1-result', 'tool', 6, [result('c1')]),
  row('read-2', 'assistant', 40, [
    { type: 'text', text: 'The scan is waiting on two workers that never reported.' },
    call('c2', 'rg -n "worker_done" scan.log')
  ]),
  row('read-2-result', 'tool', 41, [result('c2')])
]
const afterFollowUp = [
  row('read-3', 'assistant', 380, [call('c3', 'ls ~/transcripts')]),
  row('read-3-result', 'tool', 381, [result('c3')])
]
const answer = row('answer', 'assistant', 600, [
  { type: 'text', text: 'Both workers hit a usage limit and exited without reporting.' }
])

const context: Omit<NativeChatTranscriptRowContext, 'expandedTurnIds' | 'onToggleExpandedTurn'> = {
  turnBot: { name: 'Release bot', src: null, fallback: 'R' },
  expandSignal: false,
  revealedDiff: null,
  taskListPredecessors: new Map(),
  onScrollMessageToTop: () => {},
  readerAtEnd: () => true,
  onRevealDiff: () => {}
}

function Transcript({
  messages,
  running
}: {
  messages: NativeChatMessage[]
  running: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const live: NativeChatTurnStatus = { startedAt: start, thinking: false, workedSeconds: null }
  const settled: NativeChatTurnStatus = { startedAt: start, thinking: false, workedSeconds: 600 }
  const slots = buildNativeChatTranscriptSlots({
    messages,
    turnKeys: messages.map(() => 'ask'),
    liveTurnKey: 'ask',
    receipts: new Map(),
    turnStatuses: running
      ? { active: live, completedByTurn: {} }
      : { active: settled, completedByTurn: { ask: settled } },
    turnDiffs: new Map(),
    expandedTurnKeys: expanded,
    isWorking: running,
    lifecycleWorking: false
  })
  return (
    <div className="flex flex-col gap-5 bg-chat-pane p-4">
      <NativeChatTranscriptRowStack
        slots={slots}
        context={{
          ...context,
          expandedTurnIds: expanded,
          onToggleExpandedTurn: (turnKey) =>
            setExpanded((current) => {
              const next = new Set(current)
              if (!next.delete(turnKey)) {
                next.add(turnKey)
              }
              return next
            })
        }}
      />
      {running ? (
        <NativeChatTurnActivityLine
          line={{ thinking: false, stopping: false, activityText: null, reasoning: null }}
        />
      ) : null}
    </div>
  )
}

const expandFirstTurnBar = (frame: HTMLElement): void => {
  frame.querySelector<HTMLButtonElement>('button[data-native-chat-turn-status="settled"]')?.click()
}

/** The person wrote into the running turn: the work before it reads settled, the clock runs below it. */
export const runningWithFollowUp = defineFixture({
  width: 720,
  render: () => (
    <Transcript messages={[ask, ...beforeFollowUp, followUp, ...afterFollowUp]} running />
  )
})

/** The same, with the work before the follow-up opened from its row. */
export const runningWithFollowUpExpanded = defineFixture({
  width: 720,
  render: () => (
    <Transcript messages={[ask, ...beforeFollowUp, followUp, ...afterFollowUp]} running />
  ),
  interact: expandFirstTurnBar
})

/** That turn once it ends: one "Worked for" with the whole turn's time. */
export const settledWithFollowUp = defineFixture({
  width: 720,
  render: () => (
    <Transcript
      messages={[ask, ...beforeFollowUp, followUp, ...afterFollowUp, answer]}
      running={false}
    />
  )
})

/** A running turn nobody wrote into. */
export const running = defineFixture({
  width: 720,
  render: () => <Transcript messages={[ask, ...beforeFollowUp]} running />
})

/** A settled turn nobody wrote into. */
export const settled = defineFixture({
  width: 720,
  render: () => <Transcript messages={[ask, ...beforeFollowUp, answer]} running={false} />
})
