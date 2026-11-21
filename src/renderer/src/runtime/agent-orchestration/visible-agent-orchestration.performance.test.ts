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

it('keeps rows equal to a full rebuild across adds, moves and closes', () => {
  let source: AppState['unifiedTabsByWorktree'] = {
    'wt-a': [chatTab('wt-a', 'a1'), chatTab('wt-a', 'a2')],
    'wt-b': [chatTab('wt-b', 'b1')]
  }
  for (let index = 0; index < 50; index += 1) {
    source[`wt-${index}`] = [chatTab(`wt-${index}`, `filler-${index}`)]
  }
  const rows = () => [...representedOrchestrationWorktrees(stateWith(source)).entries()].sort()
  const rebuilt = () => [...representedOrchestrationWorktrees(stateWith({ ...source })).entries()]
  rows()
  const steps: [string, Tab[] | null][][] = [
    [['wt-c', [chatTab('wt-c', 'c1')]]],
    [
      ['wt-a', [chatTab('wt-a', 'a2')]],
      ['wt-b', [chatTab('wt-b', 'b1'), chatTab('wt-b', 'a1')]]
    ],
    [['wt-b', null]],
    [['wt-a', [{ ...chatTab('wt-a', 'a2'), executionHostId: 'runtime:env-1' }]]]
  ]
  for (const step of steps) {
    source = replaceTabBuckets(source, step)
    const before = visibleOrchestrationWorkForTest().visits
    const incremental = rows()
    expect(visibleOrchestrationWorkForTest().visits - before).toBeLessThanOrEqual(4)
    expect(incremental).toEqual(rebuilt().sort())
    rows()
  }
  expect(rows().filter(([, worktreeId]) => !worktreeId.startsWith('wt-'))).toEqual([])
  expect(new Set(rows().map(([, worktreeId]) => worktreeId)).has('wt-b')).toBe(false)
})
