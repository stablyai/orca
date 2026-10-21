import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalProducerLinkage,
  AgentJournalRenderItem
} from '../../../../shared/agent-session-journal-types'
import type { AgentSessionHistoryPage } from '../../../../shared/agent-session-wire'
import { projectNativeChatTranscript } from '../../../../shared/native-chat-transcript-projection'
import { projectStructuredItemsToNativeChat } from '../../../../shared/structured-agent-session-projection'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../../shared/structured-agent-session-reducer'
import { compareMessages } from './native-chat-session-assembler'
import { nativeChatSubagentSections } from './native-chat-subagent-sections'
import { nativeChatSubagentLiveSections } from './native-chat-subagent-live-frontier'

// The live window the renderer draws sections from, through the real reducer: a
// section keeps its name and state whatever the window trims or never loaded.

const child: AgentJournalProducerLinkage = { agentId: 'task-1', producerKind: 'agent' }

function item(
  itemId: string,
  sequence: number,
  body: AgentJournalItemBody,
  linkage: AgentJournalProducerLinkage = {}
): AgentJournalRenderItem {
  return { itemId, revision: 1, sequence, observedAt: sequence, body, ...linkage }
}

const said = (role: 'user' | 'assistant', text: string): AgentJournalItemBody => ({
  kind: 'message',
  role,
  blocks: [{ type: 'text', text }]
})

const rosterBody: AgentJournalItemBody = {
  kind: 'message',
  role: 'system',
  blocks: [
    {
      type: 'subagent-group',
      groupId: 'group-1',
      agents: [{ id: 'task-1', label: 'review the PR', state: 'working' }]
    }
  ]
}

function snapshotPage(items: AgentJournalRenderItem[]): AgentSessionHistoryPage {
  const newest = items.at(-1)?.sequence ?? 0
  return {
    sessionId: 'session-a',
    epoch: 'epoch-a',
    direction: 'tail',
    items,
    removedItemIds: [],
    submissions: [],
    window: {
      oldest: { epoch: 'epoch-a', sequence: items[0]?.sequence ?? 0 },
      newest: { epoch: 'epoch-a', sequence: newest },
      nextCursor: { epoch: 'epoch-a', sequence: items[0]?.sequence ?? 0 }
    },
    liveCursor: { epoch: 'epoch-a', sequence: newest },
    hasOlder: false,
    hasNewer: false
  }
}

function snapshot(items: AgentJournalRenderItem[]): StructuredAgentSessionState {
  return reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
    type: 'event',
    event: { type: 'snapshot', sessionId: 'session-a', fence: 1, page: snapshotPage(items) }
  })
}

/** Live batches of `size` items each; `cursor` defaults to each batch's newest item. */
function stream(
  state: StructuredAgentSessionState,
  items: AgentJournalRenderItem[],
  size = 1,
  cursor?: number
): StructuredAgentSessionState {
  let current = state
  for (let start = 0; start < items.length; start += size) {
    const batch = items.slice(start, start + size)
    current = reduceStructuredAgentSession(current, {
      type: 'event',
      event: {
        type: 'batch',
        sessionId: 'session-a',
        batch: {
          cursor: { epoch: 'epoch-a', sequence: cursor ?? batch.at(-1)!.sequence },
          items: batch,
          removedItemIds: [],
          submissions: []
        }
      }
    })
  }
  return current
}

function sectionsOf(state: StructuredAgentSessionState) {
  const messages = projectStructuredItemsToNativeChat(state.items)
  const { conversation, subagentRows } = projectNativeChatTranscript(messages, compareMessages)
  return {
    conversation,
    sections: nativeChatSubagentSections(conversation, subagentRows, state.subagentRoster)
  }
}

const opening = () =>
  snapshot([item('prompt', 1, said('user', 'review the PR')), item('roster', 2, rosterBody)])

// Past the every-agent cap, so the burst trims the prompt and the roster row.
const longBurst = Array.from({ length: 4_200 }, (_, index) =>
  item(`child-${index}`, index + 3, said('assistant', `step ${index}`), child)
)

describe('subagent sections over the live retained window', () => {
  it("keeps a working subagent's section named, under its roster, through a long burst", () => {
    const opened = snapshot([
      item('prompt', 1, said('user', 'review the PR')),
      item('roster', 2, rosterBody)
    ])
    const burst = Array.from({ length: 1_500 }, (_, index) =>
      item(`child-${index}`, index + 3, said('assistant', `step ${index}`), child)
    )

    const { conversation, sections } = sectionsOf(stream(opened, burst))

    expect(sections.entries.get('task-1')?.label).toBe('review the PR')
    expect(sections.anchoredAt.get('roster')).toEqual(['task-1'])
    expect(sections.openAt.get(null)).toBeUndefined()
    expect(conversation.map((message) => message.id)).toEqual(['prompt', 'roster'])
  })

  it("keeps a trimmed roster's subagent named at the head when the parent's rows trim the roster", () => {
    const opened = snapshot([
      item('prompt', 1, said('user', 'review the PR')),
      item('roster', 2, rosterBody),
      ...Array.from({ length: 5 }, (_, index) =>
        item(`child-${index}`, index + 3, said('assistant', `step ${index}`), child)
      )
    ])
    // The parent's own rows pass the retained limit, trimming the prompt and the roster.
    const parent = Array.from({ length: 1_024 }, (_, index) =>
      item(`own-${index}`, index + 8, said('assistant', `note ${index}`))
    )

    const { conversation, sections } = sectionsOf(stream(opened, parent))

    expect(conversation[0]?.id).toBe('own-0')
    expect(sections.openAt.get(null)).toEqual(['task-1'])
    expect(sections.entries.get('task-1')?.label).toBe('review the PR')
  })

  it('keeps a section named and live after a burst trims the roster row naming it', () => {
    const { conversation, sections } = sectionsOf(stream(opening(), longBurst, 100))

    expect(conversation).toEqual([])
    expect(sections.anchoredAt.size).toBe(0)
    expect(sections.openAt.get(null)).toEqual(['task-1'])
    expect(sections.entries.get('task-1')?.label).toBe('review the PR')
    // The parent has produced nothing since, so the section is still its live frontier.
    expect(nativeChatSubagentLiveSections(conversation, sections, true)).toEqual(
      new Set(['task-1'])
    )
  })

  it("takes a trimmed roster row's revision, though the row is outside the window", () => {
    const trimmed = stream(opening(), longBurst, 100)
    const settled: AgentJournalRenderItem = {
      ...item('roster', 2, {
        kind: 'message',
        role: 'system',
        blocks: [
          {
            type: 'subagent-group',
            groupId: 'group-1',
            agents: [{ id: 'task-1', label: 'review the PR', state: 'completed' }]
          }
        ]
      }),
      revision: 2
    }

    const after = stream(trimmed, [settled], 1, 4_203)

    expect(after.items.some((next) => next.itemId === 'roster')).toBe(false)
    expect(sectionsOf(after).sections.entries.get('task-1')?.state).toBe('completed')
  })

  it('stops naming a subagent once a revision of its roster row drops it, as a fresh read would', () => {
    const rows = [
      item('prompt', 1, said('user', 'review the PR')),
      item('roster', 2, rosterBody),
      item('child-0', 3, said('assistant', 'step 0'), child)
    ]
    // The host drops an entry it learns was never a subagent, rewriting the roster row.
    const dropped: AgentJournalRenderItem = {
      ...item('roster', 2, {
        kind: 'message',
        role: 'system',
        blocks: [
          {
            type: 'subagent-group',
            groupId: 'group-1',
            agents: [{ id: 'task-2', label: 'tests', state: 'working' }]
          }
        ]
      }),
      revision: 2
    }

    const live = sectionsOf(stream(snapshot(rows), [dropped], 1, 3))
    const fresh = sectionsOf(snapshot([rows[0]!, dropped, rows[2]!]))

    expect(live.sections.entries.get('task-1')).toBeUndefined()
    expect(live.sections.entries).toEqual(fresh.sections.entries)
    expect(nativeChatSubagentLiveSections(live.conversation, live.sections, true)).toEqual(
      new Set()
    )
  })

  it('forgets every name on an epoch reset', () => {
    const named = stream(opening(), longBurst.slice(0, 3))
    expect(named.subagentRoster?.size).toBe(1)
    const reset = reduceStructuredAgentSession(named, {
      type: 'event',
      event: {
        type: 'reset',
        sessionId: 'session-a',
        fence: 1,
        reset: 'epoch_changed',
        page: { ...snapshotPage([item('fresh', 1, said('user', 'again'))]), epoch: 'epoch-b' }
      }
    })

    expect(reset.subagentRoster?.size).toBe(0)
  })

  it('names nothing in a transcript without subagents', () => {
    const plain = stream(snapshot([item('prompt', 1, said('user', 'hi'))]), [
      item('reply', 2, said('assistant', 'hello'))
    ])

    expect(plain.subagentRoster?.size).toBe(0)
    expect(sectionsOf(plain).sections).toEqual(
      nativeChatSubagentSections(sectionsOf(plain).conversation, new Map())
    )
  })

  it('names a section from the entries a page carries beside its items, and falls back without them', () => {
    const page = snapshotPage([
      item('own-2', 10, said('assistant', 'meanwhile')),
      item('child-2', 11, said('assistant', 'step 2'), child)
    ])
    const open = (from: AgentSessionHistoryPage) =>
      sectionsOf(
        reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
          type: 'history-page',
          page: from
        })
      ).sections
    const entry = { id: 'task-1', label: 'review the PR', state: 'working' as const }

    const named = open({
      ...page,
      subagentRoster: [{ itemId: 'roster', sequence: 2, revision: 1, entry }]
    })
    expect(named.entries.get('task-1')).toEqual(entry)
    expect(named.openAt.get(null)).toEqual(['task-1'])

    // An older host sends no entries: the section still holds the rows, unnamed.
    const unnamed = open(page)
    expect(unnamed.entries.get('task-1')).toBeUndefined()
    expect(unnamed.openAt.get(null)).toEqual(['task-1'])
  })
})
