import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../shared/agent-session-journal-types'
import type {
  NativeChatMessage,
  NativeChatSubagentState
} from '../../../../shared/native-chat-types'
import { projectNativeChatTranscript } from '../../../../shared/native-chat-transcript-projection'
import { nativeChatRowsInDrawOrder } from '../../../../shared/native-chat-turn-grouping'
import {
  nativeChatTurnMembership,
  type NativeChatTurnJournal
} from '../../../../shared/native-chat-turn-membership'
import { compareMessages } from './native-chat-session-assembler'
import {
  nativeChatRowsInTranscriptOrder,
  nativeChatSubagentRowsInOrder,
  nativeChatSubagentSections
} from './native-chat-subagent-sections'
import {
  buildNativeChatTranscriptSlots,
  nativeChatSlotKey,
  type NativeChatMessageSlot,
  type NativeChatTranscriptSlot
} from './native-chat-transcript-slots'
import { nativeChatTurnDiffs } from './native-chat-turn-diffs'

let sequence = 0

function row(
  id: string,
  blocks: NativeChatMessage['blocks'],
  overrides: Partial<NativeChatMessage> = {}
): NativeChatMessage {
  sequence += 1
  return {
    id,
    role: 'assistant',
    blocks,
    timestamp: 1,
    source: 'transcript',
    journalPosition: { sequence, index: 0 },
    ...overrides
  }
}

const say = (value: string) => [{ type: 'text' as const, text: value }]
const call = (name: string) => [{ type: 'tool-call' as const, name, input: {} }]
const by = (agentId: string, parentAgentId?: string) => ({
  agentId,
  producerKind: 'agent' as const,
  ...(parentAgentId === undefined ? {} : { parentAgentId })
})

function roster(id: string, agents: [string, string, NativeChatSubagentState][]) {
  return row(
    id,
    [
      {
        type: 'subagent-group',
        groupId: `group-${id}`,
        agents: agents.map(([agentId, label, state]) => ({ id: agentId, label, state }))
      }
    ],
    { role: 'system' }
  )
}

/** The journal a scoped host writes for `rows`: each turn's record, then the rows it
 *  scopes to that turn; every other row belongs to none. */
function journalOf(
  rows: readonly NativeChatMessage[],
  turns: readonly [turnItemId: string, userItemId: string, rowIds: readonly string[]][]
): NativeChatTurnJournal {
  const scopeOf = new Map(
    turns.flatMap(([turnItemId, , rowIds]) => rowIds.map((rowId) => [rowId, turnItemId] as const))
  )
  const item = (
    itemId: string,
    body: AgentJournalItemBody,
    turnItemId: string | undefined,
    message?: NativeChatMessage
  ): AgentJournalRenderItem => ({
    itemId,
    body,
    sequence: 0,
    observedAt: 0,
    revision: 1,
    ...(message?.agentId === undefined ? {} : { agentId: message.agentId }),
    turnScope: turnItemId === undefined ? { kind: 'thread' } : { kind: 'turn', turnItemId }
  })
  const items = rows.flatMap((message) => {
    const role = message.role === 'user' ? 'user' : 'assistant'
    const own = item(
      message.id,
      { kind: 'message', role, blocks: [] },
      scopeOf.get(message.id),
      message
    )
    const opened = turns.find(([, userItemId]) => userItemId === message.id)
    return opened === undefined
      ? [own]
      : [
          own,
          item(
            opened[0],
            {
              kind: 'turn',
              turnId: opened[0],
              state: 'completed',
              userItemId: message.id,
              startedAt: 0
            },
            undefined
          )
        ]
  })
  return { items, submissions: [] }
}

/** `journal`: what places each row in its turn, as the list gets it. */
function sectionsOf(rows: NativeChatMessage[], journal?: NativeChatTurnJournal) {
  const { conversation, subagentRows } = projectNativeChatTranscript(rows, compareMessages, journal)
  return { conversation, sections: nativeChatSubagentSections(conversation, subagentRows) }
}

/** The conversation's rows in draw order with their turns, as the list resolves them. */
function turnRowsOf(conversation: readonly NativeChatMessage[], journal?: NativeChatTurnJournal) {
  const { turnKeys, liveTurnKey, drawOrder } = nativeChatTurnMembership(conversation, journal)
  return {
    messages: nativeChatRowsInDrawOrder(conversation, drawOrder),
    turnKeys: nativeChatRowsInDrawOrder(turnKeys, drawOrder),
    liveTurnKey
  }
}

/** `choices` and `rosters`: the sections and roster lists the reader opened (true) or
 *  closed (false) by hand. */
function slotsOf(
  rows: NativeChatMessage[],
  choices: Record<string, boolean> = {},
  isWorking = false,
  rosters: Record<string, boolean> = {},
  journal?: NativeChatTurnJournal
): NativeChatTranscriptSlot[] {
  const { conversation, sections } = sectionsOf(rows, journal)
  return buildNativeChatTranscriptSlots({
    ...turnRowsOf(conversation, journal),
    receipts: new Map(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map(),
    expandedTurnKeys: new Set(),
    isWorking,
    lifecycleWorking: false,
    subagentSections: sections,
    subagentChoices: {
      sections: new Map(Object.entries(choices)),
      rosters: new Map(Object.entries(rosters))
    }
  })
}

/** One line per thing drawn: `>` per section it sits in, then a row id, `•agent` for a
 *  roster entry, or `[agent]` for a section head; ` open` when that agent's section is. */
function outline(slots: readonly NativeChatTranscriptSlot[]): string[] {
  const entry = (agentId: string, open: boolean | undefined) => `•${agentId}${open ? ' open' : ''}`
  return slots.flatMap((slot) => {
    const indent = '>'.repeat(slot.depth)
    switch (slot.kind) {
      case 'message':
        return [
          `${indent}${slot.message.id}`,
          ...entriesInRow(slot).map(([id, open]) => entry(id, open))
        ]
      case 'subagent':
        return [`${indent}[${slot.agentId}${slot.expanded ? ' open' : ''}]`]
      case 'subagent-entries':
        return slot.agents.map(
          (agent) => `${indent}${entry(agent.id, slot.sections.get(agent.id))}`
        )
    }
  })
}

/** The entries a roster row draws: none while its list is closed, else through its first open one. */
function entriesInRow(slot: NativeChatMessageSlot): [string, boolean][] {
  const roster = slot.subagentRoster
  const drawn: [string, boolean][] = []
  for (const block of roster?.open ? slot.message.blocks : []) {
    for (const agent of block.type === 'subagent-group' ? block.agents : []) {
      const open = roster?.sections.get(agent.id) === true
      drawn.push([agent.id, open])
      if (open) {
        return drawn
      }
    }
  }
  return drawn
}

function transcriptWith(state: NativeChatSubagentState): NativeChatMessage[] {
  return [
    row('ask', say('review the PR'), { role: 'user' }),
    roster('spawn', [['task-1', 'explore the lane', state]]),
    row('child-look', say('Looking at the diff.'), by('task-1')),
    row('child-grep', call('Grep'), by('task-1')),
    row('answer', say('Delegated; the summary follows.')),
    row('child-verdict', say('The PR is CLEAN.'), by('task-1'))
  ]
}

const OPEN_UNDER_ROSTER = [
  'ask',
  'spawn',
  '•task-1 open',
  '>child-look',
  '>child-verdict',
  'answer'
]

describe("a subagent's rows live in its own section", () => {
  const settled = transcriptWith('completed')

  it("draws none of a settled agent's rows until the reader opens it from its roster", () => {
    const slots = slotsOf(settled)
    expect(outline(slots)).toEqual(['ask', 'spawn', 'answer'])
    const spawn = slots[1]
    expect(spawn?.kind === 'message' ? spawn.subagentRoster : null).toEqual({
      open: false,
      sections: new Map([['task-1', false]])
    })
  })

  it('opens them under its own entry in the roster that names the agent, named nowhere else', () => {
    const slots = slotsOf(settled, { 'task-1': true })
    expect(outline(slots)).toEqual(OPEN_UNDER_ROSTER)
    expect(slots.filter((slot) => slot.kind !== 'message')).toEqual([])
    expect(new Set(slots.map(nativeChatSlotKey)).size).toBe(slots.length)
  })

  // The parent's live line speaks for the session's own agent only, so a child's open block draws.
  it("draws a working agent's open reasoning in its section", () => {
    const thinking = row('child-think', say('Comparing the two diffs'), {
      ...by('task-1'),
      role: 'reasoning',
      state: 'running'
    })
    const rows = [...transcriptWith('working').slice(0, 3), thinking]
    expect(outline(slotsOf(rows, { 'task-1': true }, true))).toContain('>child-think')
  })

  // The fold reads only the conversation, so a subagent's failure after the answer is its own.
  it("folds a settled turn to the session's own answer, not a subagent's later failure", () => {
    const failed = [{ type: 'text' as const, text: 'The subagent failed.', tone: 'error' as const }]
    const rows = [
      row('ask', say('review the PR'), { role: 'user' }),
      row('look', call('Read')),
      row('answer', say('The review found nothing.')),
      row('child-failed', failed, { ...by('task-1'), role: 'system' })
    ]
    const { conversation, sections } = sectionsOf(rows)
    const slots = buildNativeChatTranscriptSlots({
      ...turnRowsOf(conversation),
      receipts: new Map(),
      turnStatuses: {
        active: null,
        completedByTurn: { ask: { startedAt: 0, thinking: false, workedSeconds: 3 } }
      },
      turnDiffs: new Map(),
      expandedTurnKeys: new Set(),
      isWorking: false,
      lifecycleWorking: false,
      subagentSections: sections
    })
    expect(outline(slots)).toEqual(['ask', 'answer', '[task-1]'])
  })

  it("reserves a section's prose the controls it keeps inside the section", () => {
    const same = [
      row('ask', say('review the PR'), { role: 'user' }),
      roster('spawn', [['task-1', 'explore the lane', 'completed']]),
      row('child-said', say('one\ntwo'), by('task-1')),
      row('answer', say('one\ntwo'))
    ]
    const heightOf = (id: string): number | undefined =>
      slotsOf(same, { 'task-1': true }).find(
        (slot) => slot.kind === 'message' && slot.message.id === id
      )?.estimatedHeight
    expect(heightOf('child-said')! - heightOf('answer')!).toBe(20)
  })

  it("puts each open agent's rows under its own entry, and the entries after them below its rows", () => {
    const fanOut = [
      row('ask', say('review three lanes'), { role: 'user' }),
      roster('spawn', [
        ['task-a', 'lane a', 'completed'],
        ['task-b', 'lane b', 'completed'],
        ['task-c', 'lane c', 'completed']
      ]),
      row('a-look', say('Reading lane a.'), by('task-a')),
      row('b-look', say('Reading lane b.'), by('task-b')),
      row('c-look', say('Reading lane c.'), by('task-c')),
      row('answer', say('All three are clean.'))
    ]
    expect(outline(slotsOf(fanOut, { 'task-b': true }))).toEqual([
      'ask',
      'spawn',
      '•task-a',
      '•task-b open',
      '>b-look',
      '•task-c',
      'answer'
    ])
    const both = slotsOf(fanOut, { 'task-a': true, 'task-c': true })
    expect(outline(both)).toEqual([
      'ask',
      'spawn',
      '•task-a open',
      '>a-look',
      '•task-b',
      '•task-c open',
      '>c-look',
      'answer'
    ])
    expect(new Set(both.map(nativeChatSlotKey)).size).toBe(both.length)
    // The outline rail places the entries after an open section in the roster's turn.
    expect(
      both.flatMap((slot) => (slot.kind === 'subagent-entries' ? [slot.turnKey] : []))
    ).toEqual(['ask'])
  })

  it("keeps the agent's own live frontier while the roster says it works", () => {
    const live = slotsOf(transcriptWith('working'), { 'task-1': true }).filter(
      (slot) => slot.kind === 'message' && slot.trailingRun
    )
    expect(
      live.map((slot) =>
        slot.kind === 'message' ? [slot.message.id, slot.activeTurnIsWorking] : []
      )
    ).toEqual([
      ['child-verdict', true],
      ['answer', false]
    ])
  })

  it('places each section in the turn it sits in, for the outline rail', () => {
    const rows = [
      row('ask-1', say('first'), { role: 'user' }),
      row('stray', say('Unlisted.'), by('toolu_9')),
      row('reply-1', say('done')),
      row('ask-2', say('review the PR'), { role: 'user' }),
      roster('spawn', [['task-1', 'explore the lane', 'completed']]),
      row('child-look', say('Looking.'), by('task-1')),
      row('answer', say('Done.'))
    ]
    const sections = slotsOf(rows, { 'task-1': true }).flatMap((slot) =>
      slot.kind === 'subagent'
        ? [[slot.agentId, slot.turnKey]]
        : slot.depth > 0 && slot.kind === 'message'
          ? [[slot.message.id, slot.turnKey]]
          : []
    )
    expect(sections).toEqual([
      ['toolu_9', 'ask-1'],
      ['child-look', 'ask-2']
    ])
  })

  it("places a section's rows in the turn the section is shown in, not the turn each was written in", () => {
    const rows = [
      row('ask-1', say('review the PR'), { role: 'user' }),
      roster('spawn', [['task-1', 'explore the lane', 'working']]),
      row('child-look', say('Looking.'), by('task-1')),
      row('reply-1', say('Started a reviewer.')),
      row('ask-2', say('and the tests?'), { role: 'user' }),
      row('child-later', say('Still looking.'), by('task-1')),
      row('grandchild-read', say('Reading one file.'), by('task-2', 'task-1')),
      row('reply-2', say('Running them.'))
    ]
    const turns = slotsOf(rows, { 'task-1': true, 'task-2': true }).map((slot) => [
      slot.kind === 'message'
        ? slot.message.id
        : slot.kind === 'subagent'
          ? `[${slot.agentId}]`
          : slot.agents.map((agent) => agent.id).join(),
      slot.turnKey
    ])
    expect(turns).toEqual([
      ['ask-1', 'ask-1'],
      ['spawn', 'ask-1'],
      ['child-look', 'ask-1'],
      ['child-later', 'ask-1'],
      ['[task-2]', 'ask-1'],
      ['grandchild-read', 'ask-1'],
      ['reply-1', 'ask-1'],
      ['ask-2', 'ask-2'],
      ['reply-2', 'ask-2']
    ])
  })

  it('opens an agent no loaded roster names where its first row happened', () => {
    const unlisted = [
      row('ask', say('go'), { role: 'user' }),
      row('delegate', say('Delegating.')),
      row('orphan-look', say('Looking.'), by('toolu_1')),
      row('answer', say('Done.')),
      row('orphan-more', say('Still looking.'), by('toolu_1'))
    ]
    // No roster says whether it works, so nothing opens it but the reader.
    expect(outline(slotsOf(unlisted))).toEqual(['ask', 'delegate', '[toolu_1]', 'answer'])
    expect(outline(slotsOf(unlisted, { toolu_1: true }))).toEqual([
      'ask',
      'delegate',
      '[toolu_1 open]',
      '>orphan-look',
      '>orphan-more',
      'answer'
    ])
  })

  it("opens a grandchild no roster names inside its spawner's section", () => {
    const nested = [
      ...settled,
      row('grandchild-read', say('Reading one file.'), by('task-2', 'task-1')),
      row('child-last', say('Wrapping up.'), by('task-1'))
    ]
    expect(outline(slotsOf(nested, { 'task-1': true }))).toEqual([
      'ask',
      'spawn',
      '•task-1 open',
      '>child-look',
      '>child-verdict',
      '>[task-2]',
      '>child-last',
      'answer'
    ])
    expect(outline(slotsOf(nested, { 'task-1': true, 'task-2': true })).slice(5, 7)).toEqual([
      '>[task-2 open]',
      '>>grandchild-read'
    ])
    expect(sectionsOf(nested).sections.pathOf.get('grandchild-read')).toEqual(['task-1', 'task-2'])
  })

  it('opens agents whose spawners name each other in the conversation', () => {
    const looped = [
      row('ask', say('go'), { role: 'user' }),
      row('a-row', say('A.'), by('task-a', 'task-b')),
      row('b-row', say('B.'), by('task-b', 'task-a'))
    ]
    expect(outline(slotsOf(looped))).toEqual(['ask', '[task-a]', '[task-b]'])
  })
})

describe("a subagent's section is open while it is the session's live frontier", () => {
  // The parent waits on the agent: nothing it said or did comes after the roster.
  const waiting = (state: NativeChatSubagentState) => [
    row('ask', say('review the PR'), { role: 'user' }),
    roster('spawn', [['task-1', 'explore the lane', state]]),
    row('child-look', say('Looking at the diff.'), by('task-1')),
    row('child-verdict', say('The PR is CLEAN.'), by('task-1'))
  ]
  const OPEN_AT_FRONTIER = ['ask', 'spawn', '•task-1 open', '>child-look', '>child-verdict']

  it('opens while its roster is the newest thing the running session produced', () => {
    expect(outline(slotsOf(waiting('working'), {}, true))).toEqual(OPEN_AT_FRONTIER)
    // A settled agent still at the frontier stays open until the parent moves on.
    expect(outline(slotsOf(waiting('completed'), {}, true))).toEqual(OPEN_AT_FRONTIER)
  })

  it('ignores a user row after the roster', () => {
    const rows = [...waiting('working'), row('follow-up', say('and?'), { role: 'user' })]
    expect(outline(slotsOf(rows, {}, true)).slice(0, 3)).toEqual(['ask', 'spawn', '•task-1 open'])
  })

  it('closes once the parent produces anything newer, though the agent still works', () => {
    expect(outline(slotsOf(transcriptWith('working'), {}, true))).toEqual([
      'ask',
      'spawn',
      'answer'
    ])
  })

  it("opens a roster's list while the frontier or the reader's choice is on one of its agents, and a list the reader closed hides them", () => {
    const rosterOf = (slots: NativeChatTranscriptSlot[]) =>
      slots.flatMap((slot) =>
        slot.kind === 'message' && slot.subagentRoster ? [slot.subagentRoster] : []
      )
    const live = slotsOf(waiting('working'), {}, true)
    expect(rosterOf(live)).toEqual([{ open: true, sections: new Map([['task-1', true]]) }])
    expect(rosterOf(slotsOf(waiting('working'))).map(({ open }) => open)).toEqual([false])
    // The reader closed the agent from its entry: the list they used stays open.
    expect(outline(slotsOf(waiting('working'), { 'task-1': false }, true))).toEqual([
      'ask',
      'spawn',
      '•task-1'
    ])
    expect(outline(slotsOf(transcriptWith('completed'), { 'task-1': false }))).toEqual([
      'ask',
      'spawn',
      '•task-1',
      'answer'
    ])

    const closed = slotsOf(waiting('working'), {}, true, { spawn: false })
    expect(outline(closed)).toEqual(['ask', 'spawn'])
    expect(rosterOf(closed)).toEqual([{ open: false, sections: new Map([['task-1', true]]) }])
    // The section's own choice waits behind the closed list.
    const chosen = transcriptWith('completed')
    expect(outline(slotsOf(chosen, { 'task-1': true }, false, { spawn: false }))).toEqual([
      'ask',
      'spawn',
      'answer'
    ])
    expect(outline(slotsOf(chosen, { 'task-1': true }, false, { spawn: true }))).toEqual(
      OPEN_UNDER_ROSTER
    )
  })

  it('stays closed while the session is not running', () => {
    expect(outline(slotsOf(waiting('working')))).toEqual(['ask', 'spawn'])
  })

  it("keeps the reader's choice over the frontier, in either direction", () => {
    expect(outline(slotsOf(waiting('working'), { 'task-1': false }, true))).toEqual([
      'ask',
      'spawn',
      '•task-1'
    ])
    expect(outline(slotsOf(transcriptWith('working'), { 'task-1': true }, true))).toEqual(
      OPEN_UNDER_ROSTER
    )
  })

  it("opens a grandchild at its working spawner's frontier, and not once the spawner moves on or settles", () => {
    const nested = (spawner: NativeChatSubagentState, spawnerMovesOn: boolean) => [
      row('ask', say('go'), { role: 'user' }),
      roster('spawn', [['task-1', 'lead the review', spawner]]),
      row('child-look', say('Delegating a read.'), by('task-1')),
      roster('spawn-2', [['task-2', 'read one file', 'working']]),
      row('grandchild-read', say('Reading one file.'), by('task-2', 'task-1')),
      ...(spawnerMovesOn ? [row('child-last', say('Reading another.'), by('task-1'))] : [])
    ]
    const grandchild = (rows: NativeChatMessage[]) =>
      outline(slotsOf(rows, { 'task-1': true }, true)).find((line) => line.includes('task-2'))
    expect(grandchild(nested('working', false))).toBe('>[task-2 open]')
    expect(grandchild(nested('working', true))).toBe('>[task-2]')
    // A settled spawner closes its scope: nothing inside it is live.
    expect(grandchild(nested('completed', false))).toBe('>[task-2]')
  })

  it("keeps the spawner open when the host journals its grandchild's roster as the session's row", () => {
    const rows = [
      row('ask', say('go'), { role: 'user' }),
      roster('spawn', [['task-1', 'lead the review', 'working']]),
      row('child-look', say('Delegating a read.'), by('task-1')),
      roster('spawn-2', [['task-2', 'read one file', 'working']]),
      row('grandchild-read', say('Reading one file.'), by('task-2', 'task-1'))
    ]
    expect(opened(rows)).toEqual(['task-1', 'task-2'])
    // The session's own output still supersedes it.
    expect(opened([...rows, row('answer', say('Still waiting.'))])).toEqual([])
  })
})

/** The sections a running session holds open, with no choice by the reader. */
function opened(rows: NativeChatMessage[]): string[] {
  return slotsOf(rows, {}, true).flatMap((slot) => {
    if (slot.kind === 'subagent') {
      return slot.expanded ? [slot.agentId] : []
    }
    const roster = slot.kind === 'message' && slot.subagentRoster?.open ? slot.subagentRoster : null
    return Array.from(roster?.sections ?? []).flatMap(([agentId, open]) => (open ? [agentId] : []))
  })
}

function collab(id: string, tool: string, receiverThreadIds: string[]): NativeChatMessage {
  const head = JSON.stringify({
    type: 'collabAgentToolCall',
    id,
    tool,
    status: 'inProgress',
    senderThreadId: 'thread-root',
    receiverThreadIds,
    prompt: null,
    agentsStates: {}
  })
  const frame = {
    provider: 'codex',
    kind: 'item:collabAgentToolCall',
    payload: { head, byteLength: head.length, digest: 'digest', truncated: false }
  }
  return row(
    id,
    [{ type: 'text', text: 'codex · item:collabAgentToolCall', providerFrame: frame }],
    {
      role: 'system'
    }
  )
}

describe("a parent's spawn and wait calls are part of its subagents' delegation", () => {
  // Claude: one roster row per turn, written at the first spawn and revised by the next. The
  // second spawn call folds into the parent's text before it, a row drawn after the roster.
  const claudeTurn = [
    row('ask', say('review both lanes'), { role: 'user' }),
    row('spawn-call-a', call('Agent')),
    roster('spawn', [
      ['task-a', 'lane a', 'working'],
      ['task-b', 'lane b', 'working']
    ]),
    row('then', say('Now lane b.')),
    row('spawn-call-b', [
      { type: 'tool-call', name: 'Agent', input: {} },
      { type: 'tool-result', output: 'agent launched' }
    ]),
    row('a-look', say('Reading lane a.'), by('task-a')),
    row('b-look', say('Reading lane b.'), by('task-b'))
  ]

  it("keeps the newest of a turn's spawns open while the parent only spawns", () => {
    expect(opened(claudeTurn)).toEqual(['task-b'])
    // The roster itself at the frontier: its most recently added agent.
    const rosterLast = claudeTurn.filter(({ id }) => id !== 'then' && id !== 'spawn-call-b')
    expect(opened(rosterLast)).toEqual(['task-b'])
  })

  it('closes once the parent writes, or calls anything else', () => {
    expect(opened([...claudeTurn, row('answer', say('Both lanes are running.'))])).toEqual([])
    expect(opened([...claudeTurn, row('read', call('Read'))])).toEqual([])
  })

  it('reads a call the parent makes right after the roster by when it happened, not where it is drawn', () => {
    // Both calls fold into the spawn call's row, which is drawn above the roster.
    const spawned = claudeTurn.filter(({ id }) => id !== 'then' && id !== 'spawn-call-b')
    const afterRoster = (rows: NativeChatMessage[]) => [...spawned.slice(0, 3), ...rows]
    const withChildren = (rows: NativeChatMessage[]) => [...afterRoster(rows), ...spawned.slice(3)]
    expect(outline(slotsOf(withChildren([row('read', call('Read'))]), {}, true))).toEqual([
      'ask',
      'spawn-call-a',
      'spawn'
    ])
    expect(opened(withChildren([row('spawn-call-b', call('Agent'))]))).toEqual(['task-b'])
  })

  // Codex: every spawn, wait or message names its agents by thread id.
  const codexTurn = [
    row('ask', say('review both lanes'), { role: 'user' }),
    roster('spawn', [
      ['task-a', 'lane a', 'working'],
      ['task-b', 'lane b', 'working']
    ]),
    collab('spawn-call-a', 'spawnAgent', ['task-a']),
    collab('spawn-call-b', 'spawnAgent', ['task-b']),
    row('a-look', say('Reading lane a.'), by('task-a')),
    row('b-look', say('Reading lane b.'), by('task-b'))
  ]

  it('opens the agent a spawn or a wait names, and only the first one a call names', () => {
    expect(opened(codexTurn)).toEqual(['task-b'])
    expect(opened([...codexTurn, collab('wait-a', 'wait', ['task-a'])])).toEqual(['task-a'])
    expect(opened([...codexTurn, collab('wait-b', 'wait', ['task-b'])])).toEqual(['task-b'])
    expect(opened([...codexTurn, collab('wait', 'wait', ['task-b', 'task-a'])])).toEqual(['task-b'])
  })

  it('treats a call naming no agent as ordinary output', () => {
    // A wait on whichever agent reports first names none.
    expect(opened([...codexTurn, collab('wait-any', 'wait', [])])).toEqual([])
  })

  it('opens nothing for a transcript with no subagent linkage', () => {
    const unlinked = claudeTurn.filter((message) => message.agentId === undefined)
    expect(opened(unlinked)).toEqual([])
    expect(outline(slotsOf(unlinked, {}, true))).toEqual(['ask', 'spawn-call-a', 'spawn', 'then'])
  })
})

describe("a subagent's edits in its turn's changed files", () => {
  const patch = { path: 'src/a.ts' }
  const edit = [
    { type: 'tool-call' as const, name: 'Diff', input: patch, state: 'completed' as const },
    { type: 'tool-result' as const, output: '@@ -1 +1 @@\n-before\n+after' }
  ]

  it('counts the edit in the turn it was made, pointing at the subagent row and its section', () => {
    const { conversation, sections } = sectionsOf([
      row('ask', say('edit it'), { role: 'user' }),
      roster('spawn', [['task-1', 'editor', 'completed']]),
      row('child-edit', edit, by('task-1')),
      row('answer', say('Done.'))
    ])
    const turnKeys = conversation.map(() => 'ask')
    const rows = nativeChatRowsInTranscriptOrder(
      conversation,
      turnKeys,
      nativeChatSubagentRowsInOrder(sections.rows)
    )
    expect(rows.messages.map((message) => message.id)).toEqual([
      'ask',
      'spawn',
      'child-edit',
      'answer'
    ])
    const diff = nativeChatTurnDiffs(rows.messages, rows.turnKeys, sections.pathOf).get('ask')
    expect(diff?.files.map((file) => file.target)).toEqual([
      { messageId: 'child-edit', editKey: 'Diff:0', fileIndex: 0, subagentSections: ['task-1'] }
    ])
  })

  // A send queued mid-turn lands among the running turn's rows; the host's turn
  // records, not position, say the edit after it is still the running turn's.
  it("counts an edit made mid-turn in the host's turn, and heads its section there", () => {
    const rows = [
      row('ask-1', say('edit it'), { role: 'user' }),
      row('delegate', say('Delegating.')),
      row('ask-2', say('and the tests?'), { role: 'user' }),
      row('child-edit', edit, by('task-1')),
      row('answer-1', say('Edited.')),
      row('answer-2', say('Tests pass.'))
    ]
    const journal = journalOf(rows, [
      ['turn-1', 'ask-1', ['delegate', 'child-edit', 'answer-1']],
      ['turn-2', 'ask-2', ['answer-2']]
    ])
    const { conversation, sections } = sectionsOf(rows, journal)
    const { messages, turnKeys } = turnRowsOf(conversation, journal)
    const merged = nativeChatRowsInTranscriptOrder(
      messages,
      turnKeys,
      nativeChatSubagentRowsInOrder(sections.rows)
    )
    const diffs = nativeChatTurnDiffs(merged.messages, merged.turnKeys, sections.pathOf)
    expect(Array.from(diffs.keys())).toEqual(['ask-1'])
    // No roster names it, so its head sits where its first row happened: among
    // ask-1's rows, which draw ahead of the send that waited behind them.
    const turns = slotsOf(rows, {}, false, {}, journal).map((slot) => [
      slot.kind === 'subagent'
        ? `[${slot.agentId}]`
        : slot.kind === 'message'
          ? slot.message.id
          : '',
      slot.turnKey
    ])
    expect(turns).toEqual([
      ['ask-1', 'ask-1'],
      ['delegate', 'ask-1'],
      ['[task-1]', 'ask-1'],
      ['answer-1', 'ask-1'],
      ['ask-2', 'ask-2'],
      ['answer-2', 'ask-2']
    ])
  })
})
