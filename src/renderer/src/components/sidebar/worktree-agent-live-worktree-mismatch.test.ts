import { describe, expect, it } from 'vitest'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  applyLiveWorktreeMismatchLabels,
  formatLiveWorktreeMismatchLabel,
  resolveLiveWorktreeFromCwd,
  resolveLiveWorktreeMismatchLabel,
  type LiveWorktreeMismatchCandidate
} from './worktree-agent-live-worktree-mismatch'

const MAIN: LiveWorktreeMismatchCandidate = {
  id: 'repo::/repo/main',
  repoId: 'repo',
  path: '/repo/main',
  branch: 'refs/heads/main',
  displayName: 'main'
}

const FEATURE: LiveWorktreeMismatchCandidate = {
  id: 'repo::/repo/.claude/worktrees/worktree-foo',
  repoId: 'repo',
  path: '/repo/.claude/worktrees/worktree-foo',
  branch: 'refs/heads/worktree-foo',
  displayName: 'worktree-foo'
}

const OTHER_REPO: LiveWorktreeMismatchCandidate = {
  id: 'other::/other/main',
  repoId: 'other',
  path: '/other/main',
  branch: 'refs/heads/main',
  displayName: 'other-main'
}

function makeTab(worktreeId: string): TerminalTab {
  return {
    id: 'tab-1',
    worktreeId,
    ptyId: null,
    title: 'Claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeRow(overrides?: Partial<DashboardAgentRow>): DashboardAgentRow {
  const paneKey = makePaneKey('tab-1', '22222222-2222-4222-8222-222222222222')
  const entry: AgentStatusEntry = {
    paneKey,
    state: 'working',
    stateStartedAt: 1000,
    updatedAt: 1000,
    stateHistory: [],
    prompt: 'do work',
    agentType: 'claude'
  }
  return {
    paneKey,
    entry,
    tab: makeTab(MAIN.id),
    agentType: 'claude',
    rowSource: 'live',
    state: 'working',
    startedAt: 1000,
    ...overrides
  }
}

describe('resolveLiveWorktreeFromCwd', () => {
  it('picks the longest matching known worktree path', () => {
    expect(
      resolveLiveWorktreeFromCwd('/repo/.claude/worktrees/worktree-foo/src', [MAIN, FEATURE])?.id
    ).toBe(FEATURE.id)
  })

  it('returns null for ordinary paths outside known worktrees', () => {
    expect(resolveLiveWorktreeFromCwd('/tmp/scratch', [MAIN, FEATURE])).toBeNull()
  })

  it('returns null for relative or empty cwd', () => {
    expect(resolveLiveWorktreeFromCwd('relative', [MAIN])).toBeNull()
    expect(resolveLiveWorktreeFromCwd('', [MAIN])).toBeNull()
    expect(resolveLiveWorktreeFromCwd(null, [MAIN])).toBeNull()
  })
})

describe('resolveLiveWorktreeMismatchLabel', () => {
  it('labels a live cwd that maps to a sibling worktree of the same repo', () => {
    expect(
      resolveLiveWorktreeMismatchLabel({
        liveCwd: '/repo/.claude/worktrees/worktree-foo',
        attributedWorktreeId: MAIN.id,
        worktrees: [MAIN, FEATURE]
      })
    ).toBe('in worktree-foo')
  })

  it('returns null when live cwd is still inside the attributed worktree', () => {
    expect(
      resolveLiveWorktreeMismatchLabel({
        liveCwd: '/repo/main/packages/app',
        attributedWorktreeId: MAIN.id,
        worktrees: [MAIN, FEATURE]
      })
    ).toBeNull()
  })

  it('ignores other-repo path matches so ordinary multi-repo noise is avoided', () => {
    expect(
      resolveLiveWorktreeMismatchLabel({
        liveCwd: '/other/main',
        attributedWorktreeId: MAIN.id,
        worktrees: [MAIN, FEATURE, OTHER_REPO]
      })
    ).toBeNull()
  })

  it('returns null when attributed worktree is unknown', () => {
    expect(
      resolveLiveWorktreeMismatchLabel({
        liveCwd: FEATURE.path,
        attributedWorktreeId: 'missing',
        worktrees: [MAIN, FEATURE]
      })
    ).toBeNull()
  })
})

describe('formatLiveWorktreeMismatchLabel', () => {
  it('prefers branch over displayName', () => {
    expect(
      formatLiveWorktreeMismatchLabel({
        branch: 'refs/heads/worktree-foo',
        displayName: 'Scratch',
        path: '/repo/.claude/worktrees/worktree-foo'
      })
    ).toBe('in worktree-foo')
  })

  it('falls back to path basename when branch and displayName are empty', () => {
    expect(
      formatLiveWorktreeMismatchLabel({
        branch: '',
        displayName: '',
        path: '/repo/.claude/worktrees/agent-abc'
      })
    ).toBe('in agent-abc')
  })
})

describe('applyLiveWorktreeMismatchLabels', () => {
  it('annotates matching live rows and leaves same-worktree rows untouched', () => {
    const paneKey = makePaneKey('tab-1', '22222222-2222-4222-8222-222222222222')
    const otherKey = makePaneKey('tab-1', '33333333-3333-4333-8333-333333333333')
    const rows = [
      makeRow({ paneKey }),
      makeRow({
        paneKey: otherKey,
        entry: {
          ...makeRow().entry,
          paneKey: otherKey
        }
      })
    ]
    const liveCwdByPaneKey = new Map([
      [paneKey, FEATURE.path],
      [otherKey, '/repo/main/src']
    ])

    const next = applyLiveWorktreeMismatchLabels(rows, {
      liveCwdByPaneKey,
      worktrees: [MAIN, FEATURE]
    })

    expect(next[0].liveWorktreeMismatchLabel).toBe('in worktree-foo')
    expect(next[1].liveWorktreeMismatchLabel).toBeUndefined()
    // Why: attribution stays on the original worktree card — no row reparenting.
    expect(next[0].tab.worktreeId).toBe(MAIN.id)
  })

  it('uses activationPaneKey for subagent children of a mismatched parent', () => {
    const parentKey = makePaneKey('tab-1', '22222222-2222-4222-8222-222222222222')
    const child = makeRow({
      paneKey: `${parentKey}\u0000subagent:1`,
      activationPaneKey: parentKey,
      rowSource: 'subagent'
    })
    const next = applyLiveWorktreeMismatchLabels([child], {
      liveCwdByPaneKey: { [parentKey]: FEATURE.path },
      worktrees: [MAIN, FEATURE]
    })
    expect(next[0].liveWorktreeMismatchLabel).toBe('in worktree-foo')
  })

  it('returns the same array reference when nothing changes', () => {
    const rows = [makeRow()]
    const next = applyLiveWorktreeMismatchLabels(rows, {
      liveCwdByPaneKey: {},
      worktrees: [MAIN, FEATURE]
    })
    expect(next).toBe(rows)
  })
})
