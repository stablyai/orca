import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from './constants'
import type { TerminalLayoutSnapshot, TerminalTab } from './terminal-tab-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import { workspaceTerminalAuthority } from './workspace-session-partition-authority'

const WORKTREE_ID = 'repo-1::/srv/wt'
const REPO_ID = 'repo-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function tab(id: string, ptyId: string | null = null): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId: WORKTREE_ID,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function session(overrides: Partial<WorkspaceSessionState>): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), ...overrides }
}

function layout(ptyId: string | null): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf' as const, leafId: LEAF_ID },
    activeLeafId: LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: ptyId ? { [LEAF_ID]: ptyId } : undefined
  }
}

describe('workspaceTerminalAuthority', () => {
  it('does not let a one-sided revision veto the partition holding pty-bound panes', () => {
    const base = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('ghost-1'), tab('ghost-2')] },
      terminalLayoutsByTabId: { 'ghost-1': layout(null), 'ghost-2': layout(null) },
      terminalTopologyRevisionByRepoId: { [REPO_ID]: 162 }
    })
    const source = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('live-1', 'ssh:target@@pty-34')] },
      terminalLayoutsByTabId: { 'live-1': layout('ssh:target@@pty-34') }
    })

    expect(workspaceTerminalAuthority(base, source, WORKTREE_ID)).toBe('source')
  })

  it('mirrors the pty-bound tiebreak toward a live base against a revisionless source', () => {
    const base = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('live-1', 'ssh:target@@pty-3')] },
      terminalLayoutsByTabId: { 'live-1': layout('ssh:target@@pty-3') }
    })
    const source = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('ghost-1')] },
      terminalLayoutsByTabId: { 'ghost-1': layout(null) },
      terminalTopologyRevisionByRepoId: { [REPO_ID]: 7 }
    })

    expect(workspaceTerminalAuthority(base, source, WORKTREE_ID)).toBe('base')
  })

  it('yields a higher two-sided revision to the side holding pty-bound panes', () => {
    const base = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('ghost-1'), tab('ghost-2')] },
      terminalLayoutsByTabId: { 'ghost-1': layout(null), 'ghost-2': layout(null) },
      terminalTopologyRevisionByRepoId: { [REPO_ID]: 162 }
    })
    const source = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('live-1', 'ssh:target@@pty-34')] },
      terminalLayoutsByTabId: { 'live-1': layout('ssh:target@@pty-34') },
      terminalTopologyRevisionByRepoId: { [REPO_ID]: 5 }
    })

    expect(workspaceTerminalAuthority(base, source, WORKTREE_ID)).toBe('source')
  })

  it('keeps two-sided revision precedence when both sides hold pty-bound panes', () => {
    const base = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('a', 'ssh:target@@pty-1')] },
      terminalLayoutsByTabId: { a: layout('ssh:target@@pty-1') },
      terminalTopologyRevisionByRepoId: { [REPO_ID]: 9 }
    })
    const source = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('b', 'ssh:target@@pty-2')] },
      terminalLayoutsByTabId: { b: layout('ssh:target@@pty-2') },
      terminalTopologyRevisionByRepoId: { [REPO_ID]: 4 }
    })

    expect(workspaceTerminalAuthority(base, source, WORKTREE_ID)).toBe('base')
  })

  it('keeps revision precedence when both partitions record a revision', () => {
    const base = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('stale-1')] },
      terminalLayoutsByTabId: { 'stale-1': layout(null) },
      terminalTopologyRevisionByRepoId: { [REPO_ID]: 3 }
    })
    const source = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('live-1', 'ssh:target@@pty-1')] },
      terminalLayoutsByTabId: { 'live-1': layout('ssh:target@@pty-1') },
      terminalTopologyRevisionByRepoId: { [REPO_ID]: 9 }
    })

    expect(workspaceTerminalAuthority(base, source, WORKTREE_ID)).toBe('source')
  })

  it('counts a pane bound through its layout when the tab record carries no ptyId', () => {
    const base = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('ghost-1')] },
      terminalLayoutsByTabId: { 'ghost-1': layout(null) },
      terminalTopologyRevisionByRepoId: { [REPO_ID]: 12 }
    })
    const source = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('live-1', null)] },
      terminalLayoutsByTabId: { 'live-1': layout('ssh:target@@pty-9') }
    })

    expect(workspaceTerminalAuthority(base, source, WORKTREE_ID)).toBe('source')
  })

  it('stays ambiguous when neither side holds a pty-bound pane and bundles differ', () => {
    const base = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('a')] },
      terminalLayoutsByTabId: { a: layout(null) }
    })
    const source = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('b')] },
      terminalLayoutsByTabId: { b: layout(null) }
    })

    expect(workspaceTerminalAuthority(base, source, WORKTREE_ID)).toBe('ambiguous')
  })

  it('stays ambiguous when both sides hold pty-bound panes and bundles differ', () => {
    const base = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('a', 'ssh:target@@pty-1')] },
      terminalLayoutsByTabId: { a: layout('ssh:target@@pty-1') }
    })
    const source = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('b', 'ssh:target@@pty-2')] },
      terminalLayoutsByTabId: { b: layout('ssh:target@@pty-2') }
    })

    expect(workspaceTerminalAuthority(base, source, WORKTREE_ID)).toBe('ambiguous')
  })

  it('keeps authority with a revision winner whose tab list is explicitly empty', () => {
    const base = session({
      tabsByWorktree: { [WORKTREE_ID]: [] },
      terminalTopologyRevisionByRepoId: { [REPO_ID]: 163 }
    })
    const source = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('stale-1', 'ssh:target@@pty-dead')] },
      terminalLayoutsByTabId: { 'stale-1': layout('ssh:target@@pty-dead') }
    })

    expect(workspaceTerminalAuthority(base, source, WORKTREE_ID)).toBe('base')
  })

  it('vetoes a revision winner that has no record at all for the workspace key', () => {
    const base = session({
      terminalTopologyRevisionByRepoId: { [REPO_ID]: 12 }
    })
    const source = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('live-1', 'ssh:target@@pty-3')] },
      terminalLayoutsByTabId: { 'live-1': layout('ssh:target@@pty-3') }
    })

    expect(workspaceTerminalAuthority(base, source, WORKTREE_ID)).toBe('source')
  })

  it('still prefers the only populated side when the other has the key with no tabs', () => {
    const base = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('a')] },
      terminalTopologyRevisionByRepoId: { [REPO_ID]: 5 }
    })
    const source = session({
      tabsByWorktree: { [WORKTREE_ID]: [] }
    })

    expect(workspaceTerminalAuthority(base, source, WORKTREE_ID)).toBe('base')
  })
})
