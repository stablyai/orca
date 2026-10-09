import { describe, expect, it } from 'vitest'
import type {
  NativeChatMessage,
  NativeChatSubagentState
} from '../../../../shared/native-chat-types'
import { projectNativeChatTranscript } from '../../../../shared/native-chat-transcript-projection'
import { nativeChatTurnMembership } from '../../../../shared/native-chat-turn-membership'
import { compareMessages } from './native-chat-session-assembler'
import { nativeChatSubagentSections } from './native-chat-subagent-sections'
import {
  buildNativeChatTranscriptSlots,
  type NativeChatTranscriptSlot
} from './native-chat-transcript-slots'

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
const call = (name: string) => [{ type: 'tool-call' as const, name, input: { name } }]
const by = (agentId: string) => ({ agentId, producerKind: 'agent' as const })
const thought = (id: string, agentId?: string, state: 'running' | 'completed' = 'completed') =>
  row(id, say(`thinking ${id}`), {
    role: 'reasoning',
    state,
    ...(agentId ? by(agentId) : {})
  })
const roster = (id: string, agentId: string, state: NativeChatSubagentState) =>
  row(
    id,
    [
      {
        type: 'subagent-group',
        groupId: `group-${id}`,
        agents: [{ id: agentId, label: agentId, state }]
      }
    ],
    { role: 'system' }
  )

function slotsOf(rows: NativeChatMessage[], open: Record<string, boolean>) {
  const { conversation, subagentRows } = projectNativeChatTranscript(rows, compareMessages)
  const { turnKeys, liveTurnKey } = nativeChatTurnMembership(conversation)
  return buildNativeChatTranscriptSlots({
    messages: conversation,
    turnKeys,
    liveTurnKey,
    receipts: new Map(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map(),
    expandedTurnKeys: new Set(),
    isWorking: false,
    lifecycleWorking: false,
    subagentSections: nativeChatSubagentSections(conversation, subagentRows),
    subagentChoices: { sections: new Map(Object.entries(open)), rosters: new Map() }
  })
}

/** `>` per section a row sits in, then its id, its run's member ids, or `[agent]` for a head. */
function outline(slots: readonly NativeChatTranscriptSlot[]): string[] {
  return slots.map((slot) => {
    const indent = '>'.repeat(slot.depth)
    if (slot.kind === 'subagent') {
      return `${indent}[${slot.agentId}]`
    }
    if (slot.kind === 'subagent-entries') {
      return `${indent}${slot.agents.map((agent) => agent.id).join()}`
    }
    return `${indent}${slot.workRun?.map((member) => member.id).join('+') ?? slot.message.id}`
  })
}

describe('work runs and subagent sections', () => {
  it("draws a section's own thoughts and calls as one run", () => {
    const rows = [
      row('ask', say('go'), { role: 'user' }),
      row('a', call('Read')),
      thought('s-r1', 'helper'),
      row('s-a', call('Bash'), by('helper')),
      thought('s-r2', 'helper'),
      row('s-b', call('Grep'), by('helper')),
      row('reply', say('Done.'))
    ]
    expect(outline(slotsOf(rows, { helper: true }))).toEqual([
      'ask',
      'a',
      '[helper]',
      '>s-r1+s-a+s-r2+s-b',
      'reply'
    ])
  })

  // The head draws between the calls, open or not, so it ends the run they would have made.
  it('never runs across a section head', () => {
    const rows = [
      row('ask', say('go'), { role: 'user' }),
      row('a', call('Read')),
      row('s-a', call('Bash'), by('helper')),
      thought('r1'),
      row('c', call('Grep'))
    ]
    expect(outline(slotsOf(rows, { helper: false }))).toEqual(['ask', 'a', '[helper]', 'r1+c'])
    expect(outline(slotsOf(rows, { helper: true }))).toEqual([
      'ask',
      'a',
      '[helper]',
      '>s-a',
      'r1+c'
    ])
  })

  // Only a finished thought folds into the run: one still being thought stays in view.
  it("keeps a working section's open thought out of its run until it ends", () => {
    const rows = (state: NativeChatSubagentState, last: 'running' | 'completed') => {
      sequence = 0
      return [
        row('ask', say('go'), { role: 'user' }),
        roster('spawn', 'helper', state),
        thought('s-r1', 'helper'),
        row('s-a', call('Read'), by('helper')),
        thought('s-r2', 'helper', last)
      ]
    }
    expect(outline(slotsOf(rows('working', 'running'), { helper: true }))).toEqual([
      'ask',
      'spawn',
      '>s-r1+s-a',
      '>s-r2'
    ])
    expect(outline(slotsOf(rows('working', 'completed'), { helper: true }))).toEqual([
      'ask',
      'spawn',
      '>s-r1+s-a+s-r2'
    ])
    // A thought its finished agent never closed is not still being thought.
    expect(outline(slotsOf(rows('completed', 'running'), { helper: true }))).toEqual([
      'ask',
      'spawn',
      '>s-r1+s-a+s-r2'
    ])
  })
})
