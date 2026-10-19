import type { ParsedAgentStatusPayload } from './agent-status-types'
import type { AgentTransition } from './agent-transitions'

export type AgentTransitionStep = {
  row: Pick<ParsedAgentStatusPayload, 'state' | 'interrupted' | 'mainAgent'>
  transition: AgentTransition | null
}

/**
 * The transitions, defined once. Each scenario is one pane's hook rows from a fresh start; the
 * host's detector must emit exactly `transition` for each row, and the sort stamps stamp Recent on
 * exactly the non-null ones and raise the unread flag on every one but a prompt.
 */
export const AGENT_TRANSITION_SCENARIOS: readonly {
  name: string
  steps: readonly AgentTransitionStep[]
}[] = [
  {
    name: 'a turn: prompt, then finish',
    steps: [
      { row: { state: 'working' }, transition: 'prompt-submitted' },
      { row: { state: 'done' }, transition: 'turn-finished' }
    ]
  },
  {
    name: 'repeated statuses are not news',
    steps: [
      { row: { state: 'working' }, transition: 'prompt-submitted' },
      { row: { state: 'working' }, transition: null },
      { row: { state: 'done' }, transition: 'turn-finished' },
      { row: { state: 'done' }, transition: null }
    ]
  },
  {
    name: 'an approval mid-turn: asking is news, resuming is the same turn',
    steps: [
      { row: { state: 'working' }, transition: 'prompt-submitted' },
      { row: { state: 'blocked' }, transition: 'needs-input' },
      { row: { state: 'working' }, transition: null },
      { row: { state: 'done' }, transition: 'turn-finished' }
    ]
  },
  {
    name: 'waiting for an answer, then the next prompt',
    steps: [
      { row: { state: 'working' }, transition: 'prompt-submitted' },
      { row: { state: 'waiting' }, transition: 'needs-input' },
      { row: { state: 'done' }, transition: 'turn-finished' },
      { row: { state: 'working' }, transition: 'prompt-submitted' }
    ]
  },
  {
    name: 'a failed turn is an error',
    steps: [
      { row: { state: 'working' }, transition: 'prompt-submitted' },
      {
        row: { state: 'done', mainAgent: { state: 'done', stateStartedAt: 1, outcome: 'failure' } },
        transition: 'errored'
      }
    ]
  },
  {
    name: 'a turn the user stopped rests, and is not news',
    steps: [
      { row: { state: 'working' }, transition: 'prompt-submitted' },
      { row: { state: 'done', interrupted: true }, transition: null }
    ]
  },
  {
    name: 'a cancelled turn rests too',
    steps: [
      { row: { state: 'working' }, transition: 'prompt-submitted' },
      {
        row: {
          state: 'done',
          mainAgent: { state: 'done', stateStartedAt: 1, outcome: 'cancellation' }
        },
        transition: null
      }
    ]
  },
  {
    name: 'done with no turn before it finished nothing',
    steps: [
      { row: { state: 'done' }, transition: null },
      { row: { state: 'working' }, transition: 'prompt-submitted' }
    ]
  },
  {
    name: 'asking first is news, the turn it opens is not a prompt',
    steps: [
      { row: { state: 'blocked' }, transition: 'needs-input' },
      { row: { state: 'working' }, transition: null }
    ]
  }
]
