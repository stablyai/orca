import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../native-chat-types'
import type { OrchestrationSessionWorker } from '../../../orchestration-session-workers'
import type { AutomationRunMessage } from '../../../automations/automation-run-message'
import type { BotItemNoteBy } from '../../../bots/bot-item-note'
import { foldBotItemNotes } from '../../../bots/bot-item-note-runs'
import { nativeChatEventPlan, type NativeChatEventPlanInput } from './native-chat-event-plan'

const base = { source: 'transcript' as const, blocks: [] }

function started(id: string, dispatchId: string, at: number): NativeChatMessage {
  return {
    ...base,
    id,
    role: 'system',
    timestamp: at,
    blocks: [{ type: 'text', text: `Task for ${dispatchId}` }],
    agentStart: true,
    agentStartDispatchId: dispatchId,
    from: {
      kind: 'agent',
      orchestration: null,
      senders: [
        { party: { address: 'term_w', terminalHandle: 'term_w', orcaSessionId: null }, name: 'Fix' }
      ]
    }
  }
}

function update(id: string, address: string, at: number): NativeChatMessage {
  return {
    ...base,
    id,
    role: 'user',
    timestamp: at,
    blocks: [{ type: 'text', text: `Report ${id}` }],
    from: {
      kind: 'agent',
      orchestration: { message: 'mail-notice', mailbox: 'm', dispatchId: null, messages: [] },
      senders: [{ party: { address, terminalHandle: address, orcaSessionId: null }, name: 'Fix' }]
    }
  }
}

function link(id: string, by: BotItemNoteBy, ...refs: string[]): NativeChatMessage {
  return {
    ...base,
    id,
    role: 'system',
    timestamp: 1,
    botItemNote: {
      noteId: id,
      by,
      entries: [{ uid: 'p0', number: 1, title: 'P0', status: 'working', event: 'linked', refs }]
    }
  }
}

function said(id: string): NativeChatMessage {
  return {
    ...base,
    id,
    role: 'assistant',
    timestamp: 1,
    blocks: [{ type: 'text', text: 'On it.' }]
  }
}

function prompt(id: string): NativeChatMessage {
  return { ...base, id, role: 'user', timestamp: 1, blocks: [{ type: 'text', text: 'Go' }] }
}

const automationRun = (runId: string): AutomationRunMessage => ({
  runId,
  automation: {
    id: 'auto',
    name: 'Digest',
    enabled: true,
    nextRunAt: 20,
    updatedAt: 1,
    dtstart: 1,
    rrule: 'FREQ=DAILY',
    workspaceId: null
  },
  trigger: 'scheduled',
  instructionsLength: 0
})

function notStarted(id: string, runId: string): NativeChatMessage {
  return {
    ...base,
    id,
    role: 'system',
    timestamp: 1,
    automationRunNotStarted: {
      run: automationRun(runId),
      actsFor: [],
      error: 'Agent is busy',
      text: '',
      at: 1
    }
  }
}

function ran(id: string, runId: string): NativeChatMessage {
  return {
    ...base,
    id,
    role: 'user',
    timestamp: 2,
    blocks: [{ type: 'text', text: 'Post the digest' }],
    automationRun: automationRun(runId)
  }
}

function worker(
  dispatchId: string,
  startedAt: number,
  settledAt: number | null
): OrchestrationSessionWorker {
  return {
    dispatchId,
    taskId: 't',
    runId: 'r',
    title: 'Fix',
    agent: 'claude',
    state: settledAt === null ? 'working' : 'failed',
    liveness: 'exited',
    host: 'local',
    worktreeId: null,
    address: 'term_w',
    paneKey: null,
    chatSessionId: null,
    startedAt,
    settledAt
  }
}

/** The drawn rows: each row's id, with the ids merged into it. */
function drawn(
  rows: readonly NativeChatMessage[],
  input: Partial<NativeChatEventPlanInput> & { turnKeys: readonly (string | undefined)[] }
): string[] {
  const planned = nativeChatEventPlan(foldBotItemNotes(rows, input.turnKeys), {
    workers: [],
    ...input
  })
  expect(planned).toHaveLength(rows.length)
  return planned.flatMap((message, index) =>
    message.mergedInto !== undefined ||
    input.quiet?.rows.has(index) ||
    (message.blocks.length === 0 &&
      !message.botItemNote &&
      !message.agentStart &&
      !message.automationRunNotStarted)
      ? []
      : [
          `${
            message.mergedEvents
              ? `${message.id}<${message.mergedEvents.map((each) => each.id).join(',')}`
              : message.id
          }${message.agentStartItems ? ` for ${message.agentStartItems.map((item) => item.title).join(' ')}` : ''}`
        ]
  )
}

describe('the Linked row of a worker the chat started', () => {
  it('joins the Started row as "for" its items when the link is in its turn, before or after it', () => {
    expect(
      drawn([prompt('t1'), link('l', 'bot', 'dispatch:d1'), started('s', 'd1', 5)], {
        turnKeys: ['t1', 't1', 't1']
      })
    ).toEqual(['t1', 's for P0'])
    expect(
      drawn([prompt('t1'), started('s', 'd1', 5), link('l', 'bot', 'dispatch:d1')], {
        turnKeys: ['t1', 't1', 't1']
      })
    ).toEqual(['t1', 's for P0'])
  })

  it('joins a link in a later turn only when nothing draws between it and the Started row', () => {
    expect(
      drawn([prompt('t1'), started('s', 'd1', 5), link('l', 'bot', 'dispatch:d1')], {
        turnKeys: ['t1', 't1', 't2']
      })
    ).toEqual(['t1', 's for P0'])
    expect(
      drawn([prompt('t1'), started('s', 'd1', 5), prompt('t2'), link('l', 'bot', 'dispatch:d1')], {
        turnKeys: ['t1', 't1', 't2', 't2']
      })
    ).toEqual(['t1', 's', 't2', 'l'])
  })

  it('joins a link that lands just before its Started row, whatever turn each is in', () => {
    expect(
      drawn([prompt('t1'), link('l', 'bot', 'dispatch:d1'), started('s', 'd1', 5)], {
        turnKeys: ['t1', 't1', 't2']
      })
    ).toEqual(['t1', 's for P0'])
    expect(
      drawn([prompt('t1'), link('l', 'bot', 'dispatch:d1'), said('a'), started('s', 'd1', 5)], {
        turnKeys: ['t1', 't1', 't1', 't2']
      })
    ).toEqual(['t1', 'l', 'a', 's'])
  })

  it('joins each worker a link names to its own Started row', () => {
    expect(
      drawn(
        [
          prompt('t1'),
          started('s1', 'd1', 5),
          started('s2', 'd2', 6),
          link('l', 'bot', 'dispatch:d1', 'dispatch:d2')
        ],
        { turnKeys: ['t1', 't1', 't1', 't1'] }
      )
    ).toEqual(['t1', 's1 for P0', 's2 for P0'])
  })

  it('gives each worker only the items linked to it', () => {
    const both = link('l', 'bot', 'dispatch:d1')
    both.botItemNote!.entries.push({
      uid: 'p1',
      number: 2,
      title: 'P1',
      status: 'working',
      event: 'linked',
      refs: ['dispatch:d2']
    })
    expect(
      drawn([prompt('t1'), started('s1', 'd1', 5), started('s2', 'd2', 6), both], {
        turnKeys: ['t1', 't1', 't1', 't1']
      })
    ).toEqual(['t1', 's1 for P0', 's2 for P1'])
  })

  it('keeps links by others, links to anything else, and links read before the Started row', () => {
    // The agent's notes in one turn fold into one row, so each kept link sits in its own turn.
    const turnKeys = ['t0', 't0', 't1', 't1', 't1', 't1', 't1', 't2', 't2']
    expect(
      drawn(
        [
          prompt('t0'),
          link('earlier', 'bot', 'dispatch:d1'),
          prompt('t1'),
          started('s', 'd1', 5),
          link('owner', 'owner', 'dispatch:d1'),
          link('other', { kind: 'chat', chatId: 'c2', title: null }, 'dispatch:d1'),
          link('partly', 'bot', 'dispatch:d1', 'dispatch:d9'),
          prompt('t2'),
          link('pr', 'bot', 'pr:acme/app#5')
        ],
        { turnKeys }
      )
    ).toEqual(['t0', 'earlier', 't1', 's', 'owner', 'other', 'partly', 't2', 'pr'])
  })
})

describe('back-to-back rows about one thing', () => {
  const workers = [worker('d1', 10, 30)]

  it('merges new Dispatch updates in place, keeping earlier events newest first', () => {
    const rows = [
      prompt('t1'),
      said('a'),
      started('s', 'd1', 10),
      update('u1', 'term_w', 20),
      update('u2', 'term_w', 30)
    ]
    const turnKeys = ['t1', 't1', 't1', 't1', 't1']
    expect(drawn(rows.slice(0, 3), { turnKeys: turnKeys.slice(0, 3), workers })).toEqual([
      't1',
      'a',
      's'
    ])
    expect(drawn(rows, { turnKeys, workers })).toEqual(['t1', 'a', 'u2<u1,s'])
  })

  it('keeps apart Dispatches that reused one terminal', () => {
    expect(
      drawn([prompt('t1'), update('u1', 'term_w', 20), update('u2', 'term_w', 50)], {
        turnKeys: ['t1', 't1', 't1'],
        workers: [worker('d1', 10, 30), worker('d2', 40, 60)]
      })
    ).toEqual(['t1', 'u1', 'u2'])
  })

  it('keeps rows apart when something draws between them, but not a quiet turn’s hidden work', () => {
    const rows = [update('u1', 'term_w', 20), said('reply'), update('u2', 'term_w', 30)]
    // Each update opens its own turn, whose bar draws under it unless the turn is quiet.
    expect(drawn(rows, { turnKeys: ['u1', 'u1', 'u2'], workers })).toEqual(['u1', 'reply', 'u2'])
    expect(
      drawn(rows, {
        turnKeys: ['u1', 'u1', 'u2'],
        workers,
        quiet: { rows: new Set([1]), turns: new Set(['u1']) }
      })
    ).toEqual(['u2<u1'])
    expect(
      drawn(rows, {
        turnKeys: ['u1', 'u1', 'u2'],
        workers,
        quiet: { rows: new Set([1]), turns: new Set() }
      })
    ).toEqual(['u1', 'u2'])
  })

  it('merges a run that couldn’t start into its later run, never another run', () => {
    expect(
      drawn(
        [prompt('t1'), notStarted('n1', 'run-1'), ran('r1', 'run-1'), notStarted('n2', 'run-2')],
        {
          turnKeys: ['t1', 't1', 't1', 't1']
        }
      )
    ).toEqual(['t1', 'r1<n1', 'n2'])
  })
})
