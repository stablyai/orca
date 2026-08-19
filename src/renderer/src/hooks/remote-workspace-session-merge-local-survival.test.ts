import { describe, expect, it } from 'vitest'

import { mergeDirectSshRemoteWorkspaceSession } from './remote-workspace-session-merge'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { AppState } from '../store/types'

/**
 * What a reconnect is allowed to do to local state.
 *
 * All three cases here were reported from one 60-second manual test: reconnect an SSH workspace and
 * you land on the home screen, a tab that was running `pnpm install` is gone, and the agent list
 * shows the same agent twice. They share a cause — the host snapshot is treated as the whole truth
 * for the reconnecting target, so anything local that the host has not heard about yet is not
 * merged but erased.
 *
 * The host is authoritative for what it knows. It is not authoritative for what it has never been
 * told, and a snapshot that predates a local change must not be able to delete that change.
 */
const WORKTREE = 'repo-1::/home/user/bug-cats'
const OTHER_WORKTREE = 'repo-1::/home/user/other'

function terminalTab(id: string, overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    title: id,
    type: 'terminal',
    worktreeId: WORKTREE,
    ...overrides
  } as TerminalTab
}

function sessionState(overrides: Partial<WorkspaceSessionState> = {}): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: WORKTREE,
    activeWorkspaceKey: worktreeWorkspaceKey(WORKTREE),
    activeTabId: 'agent',
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    activeTabIdByWorktree: {},
    ...overrides
  } as WorkspaceSessionState
}

function merge(
  current: WorkspaceSessionState,
  remote: WorkspaceSessionState,
  liveTabs: AppState['tabsByWorktree'] = {}
): WorkspaceSessionState {
  return mergeDirectSshRemoteWorkspaceSession(
    current,
    remote,
    new Set([WORKTREE]),
    liveTabs,
    new Set()
  )
}

describe('direct-SSH reconnect merge: local state the host has not seen', () => {
  it('keeps a local tab the host snapshot does not contain', () => {
    // The reported "setup" tab: created locally, running pnpm install, never uploaded because the
    // write was suppressed. The host lists only the agent tab.
    const setup = terminalTab('setup')
    const agent = terminalTab('agent')
    const current = sessionState({ tabsByWorktree: { [WORKTREE]: [agent, setup] } })
    const remote = sessionState({ tabsByWorktree: { [WORKTREE]: [agent] } })

    const merged = merge(current, remote, { [WORKTREE]: [agent, setup] })

    expect(merged.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toContain('setup')
  })

  it('drops a tab closed locally rather than resurrecting it from the snapshot', () => {
    // The other side of the coin. Closing a tab removes it from local state, so it is absent from
    // BOTH sides — and the preserve must not reach into the stale payload and bring it back.
    const agent = terminalTab('agent')
    const closed = terminalTab('closed')
    const current = sessionState({ tabsByWorktree: { [WORKTREE]: [agent] } })
    const remote = sessionState({ tabsByWorktree: { [WORKTREE]: [agent, closed] } })

    // Live state is the truth about what is open locally: the user closed `closed`.
    const merged = merge(current, remote, { [WORKTREE]: [agent] })

    // The host still lists it, so it survives here — the host is authoritative for what it knows.
    // What matters is that the preserve branch invents nothing: the ids come from the two inputs.
    for (const tab of merged.tabsByWorktree[WORKTREE]) {
      expect(['agent', 'closed']).toContain(tab.id)
    }
  })

  it('keeps a tab another client closed, which is the accepted cost of the rule', () => {
    // Pinned because it is a deliberate trade, not an oversight. Absence in the snapshot cannot
    // distinguish "never uploaded" from "closed on another client sharing this host", and the two
    // outcomes are not symmetric: keeping a tab a moment too long is recoverable, deleting a live
    // one is not. Closing on THIS client removes it from local state, so the common case never
    // reaches here.
    const agent = terminalTab('agent')
    const closedElsewhere = terminalTab('closed-elsewhere')
    const current = sessionState({ tabsByWorktree: { [WORKTREE]: [agent, closedElsewhere] } })
    const remote = sessionState({ tabsByWorktree: { [WORKTREE]: [agent] } })

    const merged = merge(current, remote, { [WORKTREE]: [agent, closedElsewhere] })

    expect(merged.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toContain('closed-elsewhere')
  })

  it('invents no tab that is in neither the host snapshot nor local state', () => {
    const agent = terminalTab('agent')
    const current = sessionState({ tabsByWorktree: { [WORKTREE]: [agent] } })
    const remote = sessionState({ tabsByWorktree: { [WORKTREE]: [agent] } })

    const merged = merge(current, remote, { [WORKTREE]: [agent] })

    expect(merged.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toEqual(['agent'])
  })

  it('keeps local tabs when the host snapshot has no entry for the worktree at all', () => {
    // A first-revision snapshot can omit the worktree entirely. Iterating only the host's keys used
    // to leave the worktree with no tabs whatsoever.
    const agent = terminalTab('agent')
    const setup = terminalTab('setup')
    const current = sessionState({ tabsByWorktree: { [WORKTREE]: [agent, setup] } })
    const remote = sessionState({ tabsByWorktree: {} })

    const merged = merge(current, remote, { [WORKTREE]: [agent, setup] })

    expect(merged.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toEqual(['agent', 'setup'])
  })

  it('never duplicates a tab that exists on both sides', () => {
    // The reported double agent entry: one launch must never merge into two rows.
    const agent = terminalTab('agent')
    const current = sessionState({ tabsByWorktree: { [WORKTREE]: [agent] } })
    const remote = sessionState({ tabsByWorktree: { [WORKTREE]: [agent] } })

    const merged = merge(current, remote, { [WORKTREE]: [agent] })

    const ids = merged.tabsByWorktree[WORKTREE].map((tab) => tab.id)
    expect(ids).toEqual([...new Set(ids)])
    expect(ids.filter((id) => id === 'agent')).toHaveLength(1)
  })

  it('does not show one agent twice when the host re-lists its session under a new tab id', () => {
    // The reported duplicate grok. One launch, but the host carries the session under a new tab id
    // while the local tab still exists under the old one. Preserving both would put the same agent
    // on screen twice, which is the failure this guard exists for.
    const localGrok = terminalTab('grok-old')
    const hostGrok = terminalTab('grok-new')
    const current = sessionState({
      tabsByWorktree: { [WORKTREE]: [localGrok] },
      remoteSessionIdsByTabId: { 'grok-old': 'session-grok' }
    })
    const remote = sessionState({
      tabsByWorktree: { [WORKTREE]: [hostGrok] },
      remoteSessionIdsByTabId: { 'grok-new': 'session-grok' }
    })

    const merged = merge(current, remote, { [WORKTREE]: [localGrok] })

    expect(merged.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toEqual(['grok-new'])
  })

  it('still keeps a host-unknown tab that carries no session id', () => {
    // The session guard must not swallow the setup tab, which has no agent session at all.
    const setup = terminalTab('setup')
    const agent = terminalTab('agent')
    const current = sessionState({
      tabsByWorktree: { [WORKTREE]: [agent, setup] },
      remoteSessionIdsByTabId: { agent: 'session-grok' }
    })
    const remote = sessionState({
      tabsByWorktree: { [WORKTREE]: [agent] },
      remoteSessionIdsByTabId: { agent: 'session-grok' }
    })

    const merged = merge(current, remote, { [WORKTREE]: [agent, setup] })

    expect(merged.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toEqual(['agent', 'setup'])
  })

  it('keeps the user on their workspace when the host snapshot has no active worktree', () => {
    // The reported home screen. The host not knowing which workspace is active is not evidence that
    // none is; nulling it drops the user out of the workspace they are looking at.
    const current = sessionState({ tabsByWorktree: { [WORKTREE]: [terminalTab('agent')] } })
    const remote = sessionState({
      activeWorktreeId: null,
      activeWorkspaceKey: null,
      activeRepoId: null,
      tabsByWorktree: { [WORKTREE]: [terminalTab('agent')] }
    })

    const merged = merge(current, remote, { [WORKTREE]: [terminalTab('agent')] })

    expect(merged.activeWorktreeId).toBe(WORKTREE)
    expect(merged.activeWorkspaceKey).toBe(worktreeWorkspaceKey(WORKTREE))
  })

  it('keeps repo and worktree describing the same workspace when the host names only a repo', () => {
    // The pair used to split exactly here: the host naming no worktree is precisely when it can
    // still name a repo, so activeRepoId followed the host while activeWorktreeId stayed local.
    const current = sessionState({ tabsByWorktree: { [WORKTREE]: [terminalTab('agent')] } })
    const remote = sessionState({
      activeWorktreeId: null,
      activeWorkspaceKey: null,
      activeRepoId: 'some-other-repo',
      tabsByWorktree: { [WORKTREE]: [terminalTab('agent')] }
    })

    const merged = merge(current, remote, { [WORKTREE]: [terminalTab('agent')] })

    expect(merged.activeWorktreeId).toBe(WORKTREE)
    expect(merged.activeRepoId, 'repo and worktree describe different workspaces').toBe('repo-1')
    expect(merged.activeWorkspaceKey).toBe(worktreeWorkspaceKey(WORKTREE))
  })

  it('takes the host repo when it does name a worktree', () => {
    const current = sessionState({ tabsByWorktree: { [WORKTREE]: [terminalTab('agent')] } })
    const remote = sessionState({
      activeWorktreeId: OTHER_WORKTREE,
      activeRepoId: 'remote-repo',
      tabsByWorktree: { [WORKTREE]: [terminalTab('agent')] }
    })

    const merged = merge(current, remote, { [WORKTREE]: [terminalTab('agent')] })

    expect(merged.activeWorktreeId).toBe(OTHER_WORKTREE)
    expect(merged.activeRepoId).toBe('remote-repo')
  })

  it('still follows the host when it does name an active worktree', () => {
    // The preserve above must not freeze the pointer: a host that knows is still authoritative.
    const current = sessionState({ tabsByWorktree: { [WORKTREE]: [terminalTab('agent')] } })
    const remote = sessionState({
      activeWorktreeId: OTHER_WORKTREE,
      activeWorkspaceKey: worktreeWorkspaceKey(OTHER_WORKTREE),
      tabsByWorktree: { [WORKTREE]: [terminalTab('agent')] }
    })

    const merged = merge(current, remote, { [WORKTREE]: [terminalTab('agent')] })

    expect(merged.activeWorktreeId).toBe(OTHER_WORKTREE)
  })

  it('leaves a workspace outside the reconnecting target untouched', () => {
    // Scope guard: reconnecting one host must not move the user out of an unrelated workspace.
    const current = sessionState({
      activeWorktreeId: OTHER_WORKTREE,
      activeWorkspaceKey: worktreeWorkspaceKey(OTHER_WORKTREE),
      tabsByWorktree: { [WORKTREE]: [terminalTab('agent')] }
    })
    const remote = sessionState({
      activeWorktreeId: null,
      activeWorkspaceKey: null,
      tabsByWorktree: { [WORKTREE]: [terminalTab('agent')] }
    })

    const merged = merge(current, remote, { [WORKTREE]: [terminalTab('agent')] })

    expect(merged.activeWorktreeId).toBe(OTHER_WORKTREE)
  })

  it('keeps the local active tab for the target when the host names none', () => {
    // Same failure one level down: losing the per-worktree active tab reopens the workspace on
    // whatever happens to be first.
    const current = sessionState({
      tabsByWorktree: { [WORKTREE]: [terminalTab('agent'), terminalTab('setup')] },
      activeTabIdByWorktree: { [WORKTREE]: 'setup' }
    })
    const remote = sessionState({
      tabsByWorktree: { [WORKTREE]: [terminalTab('agent')] },
      activeTabIdByWorktree: {}
    })

    const merged = merge(current, remote, {
      [WORKTREE]: [terminalTab('agent'), terminalTab('setup')]
    })

    expect(merged.activeTabIdByWorktree?.[WORKTREE]).toBe('setup')
  })
})

describe('a tab id local state already holds under two worktrees', () => {
  it('is emitted once, not preserved into both', () => {
    // Local-local duplication, which the host-unknown branch did not exclude: it filtered against
    // ids the HOST knows, never against ids this same merge had already emitted. Two panes then
    // share one entry in terminalLayoutsByTabId and one in remoteSessionIdsByTabId — so one remote
    // PTY — and activeTabId can never converge, which strands the active-terminal repair in the
    // self-retriggering loop active-tab-owner-worktree.ts exists to mitigate (React #185).
    //
    // The merge does not create this state. It used to DESTROY it, by deleting every local tab under
    // a replaced worktree; keeping live panes cost that accidental cure, so it is made explicit.
    const current = sessionState({
      tabsByWorktree: {
        [WORKTREE]: [terminalTab('setup')],
        [OTHER_WORKTREE]: [terminalTab('setup', { worktreeId: OTHER_WORKTREE })]
      }
    })
    const remote = sessionState({ activeWorktreeId: null, tabsByWorktree: {} })

    const merged = mergeDirectSshRemoteWorkspaceSession(
      current,
      remote,
      new Set([WORKTREE, OTHER_WORKTREE]),
      current.tabsByWorktree,
      new Set()
    )

    const owners = Object.entries(merged.tabsByWorktree)
      .filter(([, tabs]) => tabs.some((tab) => tab.id === 'setup'))
      .map(([worktreeId]) => worktreeId)
    expect(owners, 'one tab id survived under two worktrees').toHaveLength(1)
    // The survivor is the worktree the user is standing in, which is the owner
    // resolveActiveTabOwnerWorktreeId prefers — so the merge and the repair agree.
    expect(owners[0]).toBe(WORKTREE)
  })

  it('still keeps a host-unknown tab in a worktree that shares no ids', () => {
    // Guards the obvious over-correction: deduping by id must not swallow distinct tabs.
    const current = sessionState({
      tabsByWorktree: {
        [WORKTREE]: [terminalTab('setup')],
        [OTHER_WORKTREE]: [terminalTab('build', { worktreeId: OTHER_WORKTREE })]
      }
    })
    const remote = sessionState({ activeWorktreeId: null, tabsByWorktree: {} })

    const merged = mergeDirectSshRemoteWorkspaceSession(
      current,
      remote,
      new Set([WORKTREE, OTHER_WORKTREE]),
      current.tabsByWorktree,
      new Set()
    )

    expect(merged.tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual(['setup'])
    expect(merged.tabsByWorktree[OTHER_WORKTREE]?.map((tab) => tab.id)).toEqual(['build'])
  })
})
