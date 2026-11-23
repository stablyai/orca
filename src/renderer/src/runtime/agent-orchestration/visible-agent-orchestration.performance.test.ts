import { expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { replaceTabBuckets } from '@/store/record-transitions/keyed-record-transitions'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { makeStructuredChatTab } from '@/store/slices/tabs/tab-group.test-fixture'
import {
  representedOrchestrationWorktrees,
  selectVisibleAgentOrchestration,
  visibleOrchestrationWorkForTest
} from './visible-agent-orchestration'
import { rowIdentities } from './orchestration-row-identities'

// Perf contract: one workspace's chat tab write re-encoded every live chat's pane ID (364k encodes in
// 40 s at 2,634 chats, all thrashing a 2,048-entry memo). It must read only that workspace's chats
// and hash no session ID that already had a row, at N and at 10N chats.

function chatTab(worktreeId: string, sessionId: string, title = 'chat'): Tab {
  return makeStructuredChatTab({
    id: `slot-${sessionId}`,
    entityId: sessionId,
    groupId: `group-${worktreeId}`,
    worktreeId,
    agentSessionAgent: 'claude',
    executionHostId: 'local',
    label: title,
    createdAt: 0
  })
}

function stateWith(unifiedTabsByWorktree: AppState['unifiedTabsByWorktree']): AppState {
  return { ...useAppStore.getState(), unifiedTabsByWorktree }
}

// A chat's pane key is `structured-agent-session-<session id>:<hash>`; tests name rows by session.
const sessionOf = (paneKey: string) =>
  paneKey.slice('structured-agent-session-'.length, paneKey.indexOf(':'))

function workForOneRetitle(chatCount: number): { encodes: number; visits: number } {
  const source: AppState['unifiedTabsByWorktree'] = {}
  for (let index = 0; index < chatCount; index += 1) {
    source[`wt-${index}`] = [chatTab(`wt-${index}`, `session-${chatCount}-${index}`)]
  }
  selectVisibleAgentOrchestration(stateWith(source))
  const before = visibleOrchestrationWorkForTest()
  const next = replaceTabBuckets(source, [
    ['wt-0', [chatTab('wt-0', `session-${chatCount}-0`, 'renamed')]]
  ])
  selectVisibleAgentOrchestration(stateWith(next))
  const after = visibleOrchestrationWorkForTest()
  return {
    encodes: after.paneKeyEncodes - before.paneKeyEncodes,
    visits: after.visits - before.visits
  }
}

it('re-reads only the changed workspace and re-encodes no live chat, at N and 10N', () => {
  for (const chatCount of [2_600, 26_000]) {
    const work = workForOneRetitle(chatCount)
    expect(work.encodes).toBe(0)
    expect(work.visits).toBeLessThanOrEqual(2)
  }
})

it('keeps the right rows across adds, moves and closes', () => {
  let source: AppState['unifiedTabsByWorktree'] = {
    'wt-a': [chatTab('wt-a', 'a1'), chatTab('wt-a', 'a2')],
    'wt-b': [chatTab('wt-b', 'b1')]
  }
  for (let index = 0; index < 50; index += 1) {
    source[`wt-${index}`] = [chatTab(`wt-${index}`, `filler-${index}`)]
  }
  const rows = () => {
    const entries = [...representedOrchestrationWorktrees(stateWith(source)).entries()]
    const named = entries.map(([pane, worktreeId]) => [sessionOf(pane), worktreeId])
    expect(named.filter(([tab]) => tab.startsWith('filler-'))).toHaveLength(50)
    return named.filter(([tab]) => !tab.startsWith('filler-')).sort()
  }
  expect(rows()).toEqual([
    ['a1', 'wt-a'],
    ['a2', 'wt-a'],
    ['b1', 'wt-b']
  ])
  const steps: [[string, Tab[] | null][], string[][]][] = [
    [
      [['wt-c', [chatTab('wt-c', 'c1')]]],
      [
        ['a1', 'wt-a'],
        ['a2', 'wt-a'],
        ['b1', 'wt-b'],
        ['c1', 'wt-c']
      ]
    ],
    [
      [
        ['wt-a', [chatTab('wt-a', 'a2')]],
        ['wt-b', [chatTab('wt-b', 'b1'), chatTab('wt-b', 'a1')]]
      ],
      [
        ['a1', 'wt-b'],
        ['a2', 'wt-a'],
        ['b1', 'wt-b'],
        ['c1', 'wt-c']
      ]
    ],
    [
      [['wt-b', null]],
      [
        ['a2', 'wt-a'],
        ['c1', 'wt-c']
      ]
    ],
    [
      [['wt-a', [{ ...chatTab('wt-a', 'a2'), executionHostId: 'runtime:env-1' }]]],
      [
        ['a2', 'wt-a'],
        ['c1', 'wt-c']
      ]
    ]
  ]
  for (const [step, expected] of steps) {
    source = replaceTabBuckets(source, step)
    const before = visibleOrchestrationWorkForTest().visits
    expect(rows()).toEqual(expected)
    expect(visibleOrchestrationWorkForTest().visits - before).toBeLessThanOrEqual(4)
  }
})

it('keeps one row per chat when tabs sharing it swap order', () => {
  const first = { ...chatTab('wt-d', 'd1'), id: 'tab-d1-first' }
  const second = { ...chatTab('wt-d', 'd1'), id: 'tab-d1-second' }
  let source: AppState['unifiedTabsByWorktree'] = {
    'wt-d': [first, second],
    'wt-e': [chatTab('wt-e', 'e1')]
  }
  const rows = () => [...rowIdentities(stateWith(source)).aliases.values()].map(sessionOf).sort()
  expect(rows()).toEqual(['d1', 'e1'])
  source = replaceTabBuckets(source, [['wt-d', [second, first]]])
  expect(rows()).toEqual(['d1', 'e1'])
  source = replaceTabBuckets(source, [['wt-d', [{ ...second, label: 'renamed' }, first]]])
  const visits = visibleOrchestrationWorkForTest().visits
  expect(rows()).toEqual(['d1', 'e1'])
  expect(visibleOrchestrationWorkForTest().visits - visits).toBeLessThanOrEqual(2)
})
