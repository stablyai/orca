import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../native-chat-types'
import type { AgentTurnOutcome } from '../../../agent-status/lifecycle/agent-turn-outcome'
import type { AutomationRunMessage } from '../../../automations/automation-run-message'
import { nativeChatQuietTurns } from './native-chat-quiet-turns'

function row(
  id: string,
  role: NativeChatMessage['role'],
  text: string,
  extra: Partial<NativeChatMessage> = {}
): NativeChatMessage {
  return {
    id,
    role,
    timestamp: 1,
    source: 'transcript',
    blocks: [{ type: 'text', text }],
    ...extra
  }
}

const WORKER: NativeChatMessage['from'] = { kind: 'agent', senders: [], orchestration: null }
const ITEM = { uid: 'item-11', number: 11, title: 'Export timeout', status: 'working' as const }
const commented = (id: string): NativeChatMessage => ({
  ...row(id, 'system', ''),
  blocks: [],
  botItemNote: { noteId: id, by: 'bot', entries: [{ ...ITEM, event: 'commented', text: 'Yes.' }] }
})
const tool = (id: string): NativeChatMessage => ({
  ...row(id, 'assistant', ''),
  blocks: [
    {
      type: 'tool-call',
      name: 'Bash',
      input: { command: 'orca bot item comment 11 --text "Yes."' },
      state: 'completed'
    }
  ]
})
const RUN: AutomationRunMessage = {
  runId: 'run-1',
  automation: {
    id: 'auto-1',
    name: 'Morning triage',
    enabled: true,
    nextRunAt: 0,
    updatedAt: 0,
    dtstart: 0,
    rrule: 'FREQ=DAILY',
    workspaceId: 'folder:w',
    bot: { botId: 'b' }
  },
  trigger: 'scheduled',
  instructionsLength: 0
}

function settled(keys: string[], verdict?: AgentTurnOutcome) {
  return Object.fromEntries(
    keys.map((key) => [
      key,
      { startedAt: 0, thinking: false, workedSeconds: 9, ...(verdict ? { verdict } : {}) }
    ])
  )
}

function quietOf(
  rows: NativeChatMessage[],
  turn: string,
  status = settled([turn]),
  keepsTurn = false
) {
  const quiet = nativeChatQuietTurns(
    rows,
    rows.map(() => turn),
    status,
    () => keepsTurn
  )
  return { hidden: [...quiet.rows].map((index) => rows[index]!.id), turns: [...quiet.turns] }
}

describe('nativeChatQuietTurns', () => {
  it('hides the bar and answer of item mail that only commented, keeping the mail and its note', () => {
    const rows = [
      row('m1', 'user', 'item mail', { from: WORKER }),
      tool('t1'),
      commented('n1'),
      row('a1', 'assistant', 'NO_REPLY')
    ]
    expect(quietOf(rows, 'm1')).toEqual({ hidden: ['t1', 'a1'], turns: ['m1'] })
  })

  it("keeps a worker update's mail and the cards Orca drew while it updated an item and started a worker", () => {
    const rows = [
      row('w1', 'user', 'repro found', { from: WORKER }),
      commented('n1'),
      { ...row('s1', 'assistant', ''), blocks: [], agentStart: true as const },
      row('a1', 'assistant', 'NO_REPLY')
    ]
    expect(quietOf(rows, 'w1')).toEqual({ hidden: ['a1'], turns: ['w1'] })
  })

  it('keeps the run row of an automation that found nothing', () => {
    const rows = [
      row('r1', 'user', 'Triage new issues.', { automationRun: RUN }),
      tool('t1'),
      row('a1', 'assistant', 'NO_REPLY')
    ]
    expect(quietOf(rows, 'r1')).toEqual({ hidden: ['t1', 'a1'], turns: ['r1'] })
  })

  it('keeps a turn that said something', () => {
    const rows = [
      row('w1', 'user', 'repro found', { from: WORKER }),
      row('a1', 'assistant', 'Filed it.\n\nNO_REPLY')
    ]
    expect(quietOf(rows, 'w1')).toEqual({ hidden: [], turns: [] })
  })

  it('keeps a quiet turn that is still running', () => {
    const rows = [
      row('w1', 'user', 'repro found', { from: WORKER }),
      row('a1', 'assistant', 'NO_REPLY')
    ]
    expect(quietOf(rows, 'w1', {})).toEqual({ hidden: [], turns: [] })
  })

  it('keeps a quiet turn that left a diff or opened a PR', () => {
    const rows = [
      row('w1', 'user', 'repro found', { from: WORKER }),
      row('a1', 'assistant', 'NO_REPLY')
    ]
    expect(quietOf(rows, 'w1', settled(['w1']), true)).toEqual({ hidden: [], turns: [] })
  })

  it.each(['gh pr create --fill', 'git push && glab mr create --fill'])(
    'keeps a quiet turn that ran `%s`',
    (command) => {
      const rows = [
        row('w1', 'user', 'repro found', { from: WORKER }),
        {
          ...row('t1', 'assistant', ''),
          blocks: [
            {
              type: 'tool-call' as const,
              name: 'Bash',
              input: { command },
              state: 'failed' as const
            }
          ]
        },
        row('a1', 'assistant', 'NO_REPLY')
      ]
      expect(quietOf(rows, 'w1')).toEqual({ hidden: [], turns: [] })
    }
  )

  it.each(['failure', 'unconfirmed'] as const)('keeps a quiet turn that ended in %s', (verdict) => {
    const rows = [
      row('w1', 'user', 'repro found', { from: WORKER }),
      row('a1', 'assistant', 'NO_REPLY')
    ]
    expect(quietOf(rows, 'w1', settled(['w1'], verdict))).toEqual({ hidden: [], turns: [] })
  })

  it('keeps a quiet answer to a message the owner typed', () => {
    const rows = [row('u1', 'user', 'Anything new?'), row('a1', 'assistant', 'NO_REPLY')]
    expect(quietOf(rows, 'u1')).toEqual({ hidden: [], turns: [] })
  })

  it('keeps a quiet card-answer turn that a person steered a message into', () => {
    const rows = [
      row('c1', 'user', 'Card google-setup/step answered: done', { orcaNotice: 'card-answer' }),
      row('s1', 'user', 'also check my calendar'),
      row('a1', 'assistant', 'NO_REPLY')
    ]
    expect(quietOf(rows, 'c1')).toEqual({ hidden: [], turns: [] })
  })

  it('hides a quiet card-answer turn whole, its hidden answer row included', () => {
    const rows = [
      row('c1', 'user', 'Card google-setup/step answered: done', { orcaNotice: 'card-answer' }),
      row('a1', 'assistant', 'NO_REPLY')
    ]
    expect(quietOf(rows, 'c1')).toEqual({ hidden: ['c1', 'a1'], turns: ['c1'] })
  })
})
