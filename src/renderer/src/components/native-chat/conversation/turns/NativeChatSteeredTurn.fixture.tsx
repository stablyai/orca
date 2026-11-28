import { useState } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatTurnStatus } from '../../../../../../shared/native-chat/transcript/turns/native-chat-turn-status'
import type { NativeChatTranscriptRowContext } from '../../messages/rows/NativeChatTranscriptRow'
import { buildNativeChatTranscriptSlots } from '../slots/native-chat-transcript-slots'
import { NativeChatTranscriptRowStack } from '../../viewport/virtualization/NativeChatTranscriptItems'
import { NativeChatTurnActivityLine } from '../../messages/reasoning/NativeChatTurnActivityLine'

// Anchored to now so the live clock reads about the same in every shot: the follow-up came 6m 14s
// in, a second one 26s later, and the newest arrived about 20s ago.
const now = Date.now()
const start = now - 420_000
const at = (seconds: number): number => start + seconds * 1000

const row = (
  id: string,
  role: NativeChatMessage['role'],
  seconds: number,
  blocks: NativeChatMessage['blocks']
): NativeChatMessage => ({ id, role, source: 'transcript', timestamp: at(seconds), blocks })

const say = (text: string): NativeChatMessage['blocks'][number] => ({ type: 'text', text })
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
const command = (id: string, seconds: number, text: string): NativeChatMessage[] => [
  row(id, 'assistant', seconds, [call(`c-${id}`, text)]),
  row(`${id}-result`, 'tool', seconds + 1, [result(`c-${id}`)])
]

const ask = row('ask', 'user', 0, [
  say('The release scan took 6 hours and is still not done. Find out why.')
])
const beforeFollowUp = [
  ...command('check', 5, 'orca orchestration check --json'),
  row('read', 'assistant', 40, [
    say('The scan is waiting on two workers that never reported.'),
    call('c-read', 'rg -n "worker_done" scan.log')
  ]),
  row('read-result', 'tool', 41, [result('c-read')])
]
const followUp = row('follow-up', 'user', 374, [
  say('Debug deeply and do a deep analysis based on all relevant transcripts.')
])
const afterFollowUp = command('transcripts', 380, 'ls ~/transcripts')
const again = row('again', 'user', 400, [say('Also check the worker logs.')])
const afterAgain = command('logs', 405, 'tail -n 200 worker.log')
const answer = row('answer', 'assistant', 600, [
  say('Both workers hit a usage limit and exited without reporting.')
])

const oneFollowUp = [ask, ...beforeFollowUp, followUp, ...afterFollowUp]
const twoFollowUps = [...oneFollowUp, again, ...afterAgain]

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

/** Opens every turn bar that folds work, top to bottom. */
const expandAll = (frame: HTMLElement): void => {
  for (const button of frame.querySelectorAll<HTMLButtonElement>(
    'button[data-native-chat-turn-status="settled"]'
  )) {
    button.click()
  }
}

/** The person wrote into the running turn: the work before it reads settled, the clock runs below it. */
export const runningWithFollowUp = defineFixture({
  width: 720,
  render: () => <Transcript messages={oneFollowUp} running />
})

/** The same, with the work before the follow-up opened from its row. */
export const runningWithFollowUpExpanded = defineFixture({
  width: 720,
  render: () => <Transcript messages={oneFollowUp} running />,
  interact: expandAll
})

/** Two messages into the running turn: each finished stretch has its own row. */
export const runningWithTwoFollowUps = defineFixture({
  width: 720,
  render: () => <Transcript messages={twoFollowUps} running />
})

/** Only the running turn's tail is loaded, and it starts on the person's follow-up. */
export const runningFromFollowUp = defineFixture({
  width: 720,
  render: () => <Transcript messages={[followUp, ...afterFollowUp]} running />
})

/** That turn once it ends: the whole turn on its own row, the stretch after the follow-up under it. */
export const settledWithFollowUp = defineFixture({
  width: 720,
  render: () => <Transcript messages={[...oneFollowUp, answer]} running={false} />
})

/** The same with every row opened. */
export const settledWithFollowUpExpanded = defineFixture({
  width: 720,
  render: () => <Transcript messages={[...oneFollowUp, answer]} running={false} />,
  interact: expandAll
})

/** A settled turn with two messages written into it. */
export const settledWithTwoFollowUps = defineFixture({
  width: 720,
  render: () => <Transcript messages={[...twoFollowUps, answer]} running={false} />
})

/** The same with every row opened. */
export const settledWithTwoFollowUpsExpanded = defineFixture({
  width: 720,
  render: () => <Transcript messages={[...twoFollowUps, answer]} running={false} />,
  interact: expandAll
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
