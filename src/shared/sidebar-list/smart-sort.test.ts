import { describe, expect, it } from 'vitest'
import type { Repo } from '../repo-types'
import type { TerminalTab } from '../workspace-layout/terminal-tab-types'
import type { Worktree } from '../worktree/types'
import { buildWorktreeComparator } from './smart-sort'
import { buildAttentionByWorktree } from './smart-attention'
import type { AgentStatusEntry } from '../agent-status/contracts/agent-status-types'
import { makePaneKey } from '../workspace-layout/stable-pane-id'

const NOW = new Date('2026-03-27T12:00:00.000Z').getTime()
const LEAF_ID_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_ID_2 = '22222222-2222-4222-8222-222222222222'

function paneKey(tabId: string, leaf: '1' | '2' = '1'): string {
  return makePaneKey(tabId, leaf === '1' ? LEAF_ID_1 : LEAF_ID_2)
}

const repoMap = new Map<string, Repo>([
  [
    'repo-1',
    {
      id: 'repo-1',
      path: '/tmp/repo-1',
      displayName: 'repo-1',
      badgeColor: '#000000',
      addedAt: 0
    }
  ]
])

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: overrides.id ?? 'wt-1',
    repoId: overrides.repoId ?? 'repo-1',
    path: overrides.path ?? `/tmp/${overrides.id ?? 'wt-1'}`,
    branch: overrides.branch ?? `refs/heads/${overrides.id ?? 'wt-1'}`,
    head: overrides.head ?? 'abc123',
    isBare: overrides.isBare ?? false,
    isMainWorktree: overrides.isMainWorktree ?? false,
    linkedIssue: overrides.linkedIssue ?? null,
    linkedPR: overrides.linkedPR ?? null,
    linkedLinearIssue: null,
    isArchived: overrides.isArchived ?? false,
    comment: overrides.comment ?? '',
    isUnread: overrides.isUnread ?? false,
    isPinned: overrides.isPinned ?? false,
    displayName: overrides.displayName ?? overrides.id ?? 'wt-1',
    sortOrder: overrides.sortOrder ?? 0,
    lastActivityAt: overrides.lastActivityAt ?? 0,
    ...(overrides.createdAt !== undefined ? { createdAt: overrides.createdAt } : {})
  }
}

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: overrides.id ?? 'tab-1',
    ptyId: overrides.ptyId ?? 'pty-1',
    worktreeId: overrides.worktreeId ?? 'wt-1',
    title: overrides.title ?? 'bash',
    customTitle: overrides.customTitle ?? null,
    color: overrides.color ?? null,
    sortOrder: overrides.sortOrder ?? 0,
    createdAt: overrides.createdAt ?? 0
  }
}

function makeEntry(overrides: Partial<AgentStatusEntry> & { paneKey: string }): AgentStatusEntry {
  return {
    state: overrides.state ?? 'working',
    prompt: overrides.prompt ?? '',
    updatedAt: overrides.updatedAt ?? NOW - 30_000,
    stateStartedAt: overrides.stateStartedAt ?? overrides.updatedAt ?? NOW - 30_000,
    agentType: overrides.agentType ?? 'codex',
    paneKey: overrides.paneKey,
    worktreeId: overrides.worktreeId,
    tabId: overrides.tabId,
    terminalTitle: overrides.terminalTitle,
    stateHistory: overrides.stateHistory ?? [],
    interrupted: overrides.interrupted,
    mainAgent: overrides.mainAgent
  }
}

function ptyMapForTabs(tabsByWorktree: Record<string, TerminalTab[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const tabs of Object.values(tabsByWorktree)) {
    for (const tab of tabs) {
      out[tab.id] = ['pty-1']
    }
  }
  return out
}

function sortSmartAt(
  now: number,
  worktrees: Worktree[],
  tabsByWorktree: Record<string, TerminalTab[]>,
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
): Worktree[] {
  const attention = buildAttentionByWorktree(
    worktrees,
    tabsByWorktree,
    agentStatusByPaneKey,
    {},
    ptyMapForTabs(tabsByWorktree),
    now
  )
  return [...worktrees].sort(buildWorktreeComparator('smart', repoMap, now, attention))
}

describe('smart sort — completed-agent eligibility clock', () => {
  // Captured regression (docs/smart-sort-agent-activity-findings.md): a `done` row whose
  // updatedAt was 3m04s newer than its completion outranked two live spinners.
  const SCREENSHOT_AT = new Date('2026-03-27T21:44:39.000Z').getTime()
  const at = (hhmmss: string): number => new Date(`2026-03-27T${hhmmss}.000Z`).getTime()

  function capturedFixture(workingUpdatedAt = at('21:44:30')) {
    const done = makeWorktree({ id: 'fix-linear-persistent', displayName: 'fix-linear-persistent' })
    const workingA = makeWorktree({ id: 'allow-editing', displayName: 'allow-editing' })
    const workingB = makeWorktree({ id: 'resume-terminal', displayName: 'resume-terminal' })
    const tabs = {
      [done.id]: [makeTab({ id: 'tab-done', worktreeId: done.id })],
      [workingA.id]: [makeTab({ id: 'tab-a', worktreeId: workingA.id })],
      [workingB.id]: [makeTab({ id: 'tab-b', worktreeId: workingB.id })]
    }
    const entries = {
      [paneKey('tab-done', '1')]: makeEntry({
        paneKey: paneKey('tab-done', '1'),
        state: 'done',
        stateStartedAt: at('21:12:09'),
        // Same-state `done` writes pushed updatedAt 3m04s past the completion.
        updatedAt: at('21:15:13')
      }),
      [paneKey('tab-a', '1')]: makeEntry({
        paneKey: paneKey('tab-a', '1'),
        state: 'working',
        stateStartedAt: workingUpdatedAt - 68_000,
        updatedAt: workingUpdatedAt
      }),
      [paneKey('tab-b', '1')]: makeEntry({
        paneKey: paneKey('tab-b', '1'),
        state: 'working',
        stateStartedAt: workingUpdatedAt - 145_000,
        updatedAt: workingUpdatedAt - 5_000
      })
    }
    return { worktrees: [done, workingA, workingB], tabs, entries }
  }

  it('ranks the two spinners above the 32-minute-old completion', () => {
    const { worktrees, tabs, entries } = capturedFixture()
    const sorted = sortSmartAt(SCREENSHOT_AT, worktrees, tabs, entries)
    expect(sorted.map((w) => w.id)).toEqual([
      'allow-editing',
      'resume-terminal',
      'fix-linear-persistent'
    ])
  })

  it('still ranks that completion above the spinners inside its own window', () => {
    const { worktrees, tabs, entries } = capturedFixture(at('21:39:50'))
    const sorted = sortSmartAt(at('21:40:00'), worktrees, tabs, entries)
    expect(sorted[0].id).toBe('fix-linear-persistent')
  })
})
