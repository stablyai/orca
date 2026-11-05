import { describe, expect, it } from 'vitest'
import type { ActivityLiveAgentState, AgentPaneThread } from '../activity/activity-thread-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { buildPaletteAgentGroups, classifyPaletteAgentThread } from './palette-agent-groups'

const NOW = 1_700_000_000_000
const HOUR = 60 * 60 * 1000

function thread(
  paneKey: string,
  options: {
    state: AgentStatusEntry['state']
    /** The pipeline's live state; absent when the pane is no longer live. */
    live?: ActivityLiveAgentState
    updatedAt?: number
    unread?: boolean
    entry?: Partial<AgentStatusEntry>
    migrationUnsupportedPtyId?: string
  }
): AgentPaneThread {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: grouping reads only these entry fields.
  const entry = {
    paneKey,
    state: options.state,
    prompt: '',
    updatedAt: options.updatedAt ?? NOW,
    stateStartedAt: options.updatedAt ?? NOW,
    stateHistory: [],
    ...options.entry
  } as AgentStatusEntry
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: grouping reads only these thread fields.
  return {
    paneKey,
    paneTitle: paneKey,
    currentAgentState: options.live ?? null,
    currentAgentEntry: options.live ? entry : null,
    paneEntry: entry,
    latestTimestamp: options.updatedAt ?? NOW,
    latestEvent: null,
    events: [],
    unread: options.unread ?? false,
    migrationUnsupportedPtyId: options.migrationUnsupportedPtyId
  } as unknown as AgentPaneThread
}

const context = { now: NOW, isNativeChat: () => false }

describe('classifyPaletteAgentThread', () => {
  it.each([
    ['fresh waiting', thread('a', { state: 'waiting', live: 'waiting' }), 'needs-you'],
    [
      'stale waiting, unseen',
      thread('a', { state: 'waiting', updatedAt: NOW - 2 * HOUR, unread: true }),
      'needs-you'
    ],
    ['stale waiting, seen', thread('a', { state: 'waiting', updatedAt: NOW - 2 * HOUR }), null],
    [
      'restored unconfirmed',
      thread('a', { state: 'blocked', live: 'blocked', entry: { restoredUnconfirmed: true } }),
      null
    ],
    [
      'migration unsupported',
      thread('a', { state: 'blocked', live: 'blocked', migrationUnsupportedPtyId: 'pty-1' }),
      null
    ],
    ['unread done', thread('a', { state: 'done', unread: true }), 'unread-results'],
    ['read done', thread('a', { state: 'done' }), null],
    ['fresh working', thread('a', { state: 'working', live: 'working' }), 'working']
  ])('%s', (_name, candidate, expected) => {
    expect(classifyPaletteAgentThread(candidate, context)).toBe(expected)
  })

  it('treats a native chat as fresh however old its last update is', () => {
    const chat = thread('chat', { state: 'waiting', live: 'waiting', updatedAt: NOW - 2 * HOUR })
    expect(classifyPaletteAgentThread(chat, context)).toBe(null)
    expect(classifyPaletteAgentThread(chat, { now: NOW, isNativeChat: () => true })).toBe(
      'needs-you'
    )
  })
})

describe('buildPaletteAgentGroups', () => {
  it('fills a shared budget of four rows in group order and counts every member', () => {
    const groups = buildPaletteAgentGroups(
      [
        thread('w1', { state: 'working', live: 'working', updatedAt: NOW - 3 }),
        thread('n1', { state: 'waiting', live: 'waiting', updatedAt: NOW - 2 }),
        thread('n2', { state: 'blocked', live: 'blocked', updatedAt: NOW - 1 }),
        thread('u1', { state: 'done', unread: true, updatedAt: NOW - 5 }),
        thread('u2', { state: 'done', unread: true, updatedAt: NOW - 4 }),
        thread('w2', { state: 'working', live: 'working', updatedAt: NOW })
      ],
      context
    )

    expect(
      groups.map((group) => [group.key, group.threads.map((t) => t.paneKey), group.total])
    ).toEqual([
      ['needs-you', ['n1', 'n2'], 2],
      ['unread-results', ['u2', 'u1'], 2],
      ['working', [], 2]
    ])
  })
})
