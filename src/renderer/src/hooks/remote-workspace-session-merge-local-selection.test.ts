import { describe, expect, it } from 'vitest'
import { mergeDirectSshRemoteWorkspaceSession } from './remote-workspace-session-merge'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'

/**
 * #19697 / #20938: every direct-SSH host republish (a title change while an agent works) carries
 * the last uploaded selection. Selection is per view, so after the first hydrate it must not move.
 */
const WORKTREE = 'repo-1::/home/user/app'
const OTHER = 'repo-1::/home/user/other'

function tab(id: string, title = id, worktreeId = WORKTREE): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function session(
  activeTabId: string | null,
  tabs: TerminalTab[],
  overrides: Partial<WorkspaceSessionState> = {}
): WorkspaceSessionState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fields below are every one the merge reads for selection.
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: WORKTREE,
    activeWorkspaceKey: worktreeWorkspaceKey(WORKTREE),
    activeTabId,
    tabsByWorktree: { [WORKTREE]: tabs },
    terminalLayoutsByTabId: {},
    activeTabIdByWorktree: activeTabId ? { [WORKTREE]: activeTabId } : {},
    ...overrides
  } as WorkspaceSessionState
}

function merge(
  current: WorkspaceSessionState,
  remote: WorkspaceSessionState,
  hydrated: boolean
): WorkspaceSessionState {
  return mergeDirectSshRemoteWorkspaceSession(
    current,
    remote,
    new Set([WORKTREE, OTHER]),
    current.tabsByWorktree,
    new Set(),
    'ssh:target-1',
    undefined,
    new Set(),
    hydrated
  )
}

const local = [tab('tab-1'), tab('tab-2'), tab('tab-3')]
const republished = [tab('tab-1', 'claude: working'), tab('tab-2'), tab('tab-3')]

describe('direct-SSH merge keeps this view’s selection after the first hydrate', () => {
  it('keeps the user’s tab when a host republish names another one', () => {
    const merged = merge(session('tab-3', local), session('tab-1', republished), true)

    expect(merged.activeTabId).toBe('tab-3')
    expect(merged.activeTabIdByWorktree?.[WORKTREE]).toBe('tab-3')
    expect(merged.tabsByWorktree[WORKTREE]?.[0]?.title).toBe('claude: working')
  })

  it('keeps the user’s workspace when the host names a different one', () => {
    const remote = session('other-1', republished, {
      activeWorktreeId: OTHER,
      activeWorkspaceKey: worktreeWorkspaceKey(OTHER),
      tabsByWorktree: { [WORKTREE]: republished, [OTHER]: [tab('other-1', 'x', OTHER)] }
    })

    const merged = merge(session('tab-3', local), remote, true)

    expect(merged.activeWorktreeId).toBe(WORKTREE)
    expect(merged.activeWorkspaceKey).toBe(worktreeWorkspaceKey(WORKTREE))
    expect(merged.activeTabId).toBe('tab-3')
  })

  it('falls back to the host pointer once the local tab is gone', () => {
    const hostTabs = [tab('tab-1'), tab('tab-2')]
    const current = session('tab-3', hostTabs)

    const merged = merge(current, session('tab-1', hostTabs), true)

    expect(merged.activeTabIdByWorktree?.[WORKTREE]).toBe('tab-1')
    expect(merged.activeTabId).toBe('tab-1')
  })

  it('still adopts the host selection on the first hydrate', () => {
    const merged = merge(session('tab-3', local), session('tab-1', republished), false)

    expect(merged.activeTabId).toBe('tab-1')
    expect(merged.activeTabIdByWorktree?.[WORKTREE]).toBe('tab-1')
  })

  it('leaves a user on the home screen there when the host names no workspace', () => {
    const current = session(null, local, {
      activeWorktreeId: null,
      activeWorkspaceKey: null,
      activeTabIdByWorktree: { [WORKTREE]: 'tab-3' }
    })
    const remote = session('tab-1', republished, {
      activeRepoId: null,
      activeWorktreeId: null,
      activeWorkspaceKey: null
    })

    const merged = merge(current, remote, true)

    expect(merged.activeWorktreeId).toBeNull()
    expect(merged.activeRepoId).toBeNull()
    expect(merged.activeTabIdByWorktree?.[WORKTREE]).toBe('tab-3')
  })
})
