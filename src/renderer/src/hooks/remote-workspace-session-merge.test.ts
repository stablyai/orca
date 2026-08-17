import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../shared/ssh-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  directSshTerminalTabKey,
  mergeDirectSshRemoteWorkspaceSession
} from './remote-workspace-session-merge'

const authority: DirectSshAuthority = {
  targetId: 'target-a',
  providerEpoch: 'epoch-a' as SshProviderEpoch,
  connectionGeneration: 3
}

function tab(worktreeId: string, ptyId: string | null, generation: number): TerminalTab {
  return { id: 'shared-tab', worktreeId, ptyId, generation } as TerminalTab
}

function session(tabsByWorktree: WorkspaceSessionState['tabsByWorktree']): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), tabsByWorktree }
}

describe('mergeDirectSshRemoteWorkspaceSession', () => {
  it('selects a local tab by worktree and tab identity instead of a colliding bare id', () => {
    const worktreeA = 'repo-a::/work-a'
    const worktreeB = 'repo-b::/work-b'
    const localA = tab(worktreeA, 'ssh:target-a@@local-a', 9)
    const localB = tab(worktreeB, 'ssh:target-b@@local-b', 99)
    const current = session({ [worktreeA]: [localA], [worktreeB]: [localB] })
    const remote = session({
      [worktreeA]: [tab(worktreeA, 'ssh:target-a@@remote-a', 1)]
    })

    const merged = mergeDirectSshRemoteWorkspaceSession(
      current,
      remote,
      new Set([worktreeA, worktreeB]),
      current.tabsByWorktree,
      new Set(),
      {},
      authority
    )

    expect(merged?.tabsByWorktree[worktreeA]?.[0]).toMatchObject({
      generation: 9,
      ptyId: 'ssh:target-a@@local-a'
    })
    expect(merged?.tabsByWorktree[worktreeB]).toBeUndefined()
  })

  it('fails closed when the resulting snapshot collides with another worktree', () => {
    const worktreeA = 'repo-a::/work-a'
    const worktreeB = 'repo-b::/work-b'
    const current = session({
      [worktreeA]: [tab(worktreeA, 'ssh:target-a@@local-a', 2)],
      [worktreeB]: [tab(worktreeB, 'ssh:target-b@@local-b', 3)]
    })
    const remote = session({
      [worktreeA]: [tab(worktreeA, 'ssh:target-a@@remote-a', 4)]
    })

    expect(
      mergeDirectSshRemoteWorkspaceSession(
        current,
        remote,
        new Set([worktreeA]),
        current.tabsByWorktree,
        new Set(),
        {},
        authority
      )
    ).toBeNull()
  })

  it.each([
    ['git worktrees', 'repo-a::/work-a', 'repo-b::/work-b'],
    ['folder workspaces', 'folder:folder-a', 'folder:folder-b']
  ])(
    'fails closed when one target owns a duplicate tab across %s',
    (_kind, worktreeA, worktreeB) => {
      const current = session({})
      const remote = session({
        [worktreeA]: [tab(worktreeA, 'ssh:target-a@@remote-a', 4)],
        [worktreeB]: [tab(worktreeB, 'ssh:target-a@@remote-b', 5)]
      })

      expect(
        mergeDirectSshRemoteWorkspaceSession(
          current,
          remote,
          new Set([worktreeA, worktreeB]),
          current.tabsByWorktree,
          new Set(),
          {},
          authority
        )
      ).toBeNull()
    }
  )

  it('rejects foreign tab, layout, mounted-leaf, and session PTYs before merge', () => {
    const worktreeId = 'repo-a::/work-a'
    const local = tab(worktreeId, 'ssh:target-a@@local-a', 9)
    const current = session({ [worktreeId]: [local] })
    current.terminalLayoutsByTabId = {
      'shared-tab': {
        root: { type: 'leaf', leafId: 'leaf-a' },
        activeLeafId: 'leaf-a',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-a': 'ssh:target-b@@foreign-layout' }
      }
    }
    const remote = session({
      [worktreeId]: [tab(worktreeId, 'ssh:target-b@@foreign-tab', 1)]
    })
    remote.terminalLayoutsByTabId = {
      'shared-tab': {
        root: { type: 'leaf', leafId: 'leaf-b' },
        activeLeafId: 'leaf-b',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-b': 'ssh:target-b@@foreign-mounted' }
      }
    }
    remote.remoteSessionIdsByTabId = { 'shared-tab': 'ssh:target-b@@foreign-session' }

    const merged = mergeDirectSshRemoteWorkspaceSession(
      current,
      remote,
      new Set([worktreeId]),
      current.tabsByWorktree,
      new Set(),
      {},
      authority
    )

    expect(merged?.tabsByWorktree[worktreeId]?.[0]?.ptyId).toBe('ssh:target-a@@local-a')
    expect(merged?.terminalLayoutsByTabId['shared-tab']).toBeUndefined()
    expect(merged?.remoteSessionIdsByTabId).toEqual({
      'shared-tab': 'ssh:target-a@@local-a'
    })
  })

  it('does not retain a foreign pending reconnect under current provider authority', () => {
    const worktreeId = 'repo-a::/work-a'
    const local = tab(worktreeId, null, 9)
    const current = session({ [worktreeId]: [local] })
    const remote = session({ [worktreeId]: [tab(worktreeId, null, 1)] })
    const tabKey = directSshTerminalTabKey(worktreeId, 'shared-tab')

    const merged = mergeDirectSshRemoteWorkspaceSession(
      current,
      remote,
      new Set([worktreeId]),
      current.tabsByWorktree,
      new Set([tabKey]),
      { 'shared-tab': 'ssh:target-b@@foreign-pending' },
      authority
    )

    expect(merged?.tabsByWorktree[worktreeId]?.[0]).toMatchObject({ generation: 9, ptyId: null })
    expect(merged?.remoteSessionIdsByTabId).toEqual({})
  })

  it('admits a newer exact-target layout and remote-session bundle', () => {
    const worktreeId = 'repo-a::/work-a'
    const current = session({
      [worktreeId]: [tab(worktreeId, 'ssh:target-a@@old', 1)]
    })
    const remote = session({
      [worktreeId]: [tab(worktreeId, 'ssh:target-a@@new', 8)]
    })
    remote.terminalLayoutsByTabId = {
      'shared-tab': {
        root: { type: 'leaf', leafId: 'leaf-a' },
        activeLeafId: 'leaf-a',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-a': 'ssh:target-a@@new' }
      }
    }
    remote.remoteSessionIdsByTabId = { 'shared-tab': 'ssh:target-a@@new' }

    const merged = mergeDirectSshRemoteWorkspaceSession(
      current,
      remote,
      new Set([worktreeId]),
      current.tabsByWorktree,
      new Set(),
      {},
      authority
    )

    expect(merged?.tabsByWorktree[worktreeId]?.[0]).toMatchObject({
      generation: 8,
      ptyId: 'ssh:target-a@@new'
    })
    expect(merged?.terminalLayoutsByTabId['shared-tab']?.ptyIdsByLeafId).toEqual({
      'leaf-a': 'ssh:target-a@@new'
    })
    expect(merged?.remoteSessionIdsByTabId).toEqual({ 'shared-tab': 'ssh:target-a@@new' })
  })
})

function namedTab(
  id: string,
  worktreeId: string,
  ptyId: string | null,
  generation?: number
): TerminalTab {
  return { id, worktreeId, ptyId, generation } as TerminalTab
}

describe('mergeDirectSshRemoteWorkspaceSession live-tab graft', () => {
  const worktreeId = 'repo-a::/work-a'

  it('grafts pty-bound local tabs missing from a snapshot of unbound rows', () => {
    const liveBound = namedTab('live-1', worktreeId, 'ssh:target-a@@pty-34')
    const liveLayoutBound = namedTab('live-2', worktreeId, null)
    const current = session({ [worktreeId]: [liveBound, liveLayoutBound] })
    current.terminalLayoutsByTabId = {
      'live-2': {
        root: { type: 'leaf', leafId: 'leaf-a' },
        activeLeafId: 'leaf-a',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-a': 'ssh:target-a@@pty-35' }
      }
    }
    current.remoteSessionIdsByTabId = { 'live-1': 'ssh:target-a@@pty-34' }
    const remote = session({
      [worktreeId]: [
        namedTab('ghost-1', worktreeId, null, 110),
        namedTab('ghost-2', worktreeId, null, 84)
      ]
    })

    const merged = mergeDirectSshRemoteWorkspaceSession(
      current,
      remote,
      new Set([worktreeId]),
      current.tabsByWorktree,
      new Set(),
      {},
      authority
    )

    expect(merged?.tabsByWorktree[worktreeId]?.map((entry) => entry.id)).toEqual([
      'ghost-1',
      'ghost-2',
      'live-1',
      'live-2'
    ])
    expect(merged?.terminalLayoutsByTabId['live-2']?.ptyIdsByLeafId).toEqual({
      'leaf-a': 'ssh:target-a@@pty-35'
    })
    expect(merged?.remoteSessionIdsByTabId).toEqual({ 'live-1': 'ssh:target-a@@pty-34' })
    expect(merged?.activeWorktreeIdsOnShutdown).toContain(worktreeId)
  })

  it('grafts a live tab whose worktree is absent from the snapshot', () => {
    const live = namedTab('live-1', worktreeId, 'ssh:target-a@@pty-34')
    const current = session({ [worktreeId]: [live] })
    const remote = session({})

    const merged = mergeDirectSshRemoteWorkspaceSession(
      current,
      remote,
      new Set([worktreeId]),
      current.tabsByWorktree,
      new Set(),
      {},
      authority
    )

    expect(merged?.tabsByWorktree[worktreeId]?.map((entry) => entry.id)).toEqual(['live-1'])
  })

  it('drops unbound local rows so dormant duplicates cannot resurrect', () => {
    const dormant = namedTab('dormant-1', worktreeId, null)
    const current = session({ [worktreeId]: [dormant] })
    const remote = session({ [worktreeId]: [namedTab('remote-1', worktreeId, null, 5)] })

    const merged = mergeDirectSshRemoteWorkspaceSession(
      current,
      remote,
      new Set([worktreeId]),
      current.tabsByWorktree,
      new Set(),
      {},
      authority
    )

    expect(merged?.tabsByWorktree[worktreeId]?.map((entry) => entry.id)).toEqual(['remote-1'])
  })

  it('does not graft a tab bound only to a foreign connection', () => {
    const foreign = namedTab('foreign-1', worktreeId, 'ssh:target-b@@pty-9')
    const current = session({ [worktreeId]: [foreign] })
    const remote = session({ [worktreeId]: [] })

    const merged = mergeDirectSshRemoteWorkspaceSession(
      current,
      remote,
      new Set([worktreeId]),
      current.tabsByWorktree,
      new Set(),
      {},
      authority
    )

    expect(merged?.tabsByWorktree[worktreeId]).toEqual([])
  })

  it('follows the snapshot placement for an id the snapshot owns elsewhere', () => {
    const worktreeB = 'repo-b::/work-b'
    const live = namedTab('moved-1', worktreeId, 'ssh:target-a@@pty-3')
    const current = session({ [worktreeId]: [live] })
    const remote = session({ [worktreeB]: [namedTab('moved-1', worktreeB, null, 7)] })

    const merged = mergeDirectSshRemoteWorkspaceSession(
      current,
      remote,
      new Set([worktreeId, worktreeB]),
      current.tabsByWorktree,
      new Set(),
      {},
      authority
    )

    expect(merged?.tabsByWorktree[worktreeId]).toBeUndefined()
    expect(merged?.tabsByWorktree[worktreeB]?.map((entry) => entry.id)).toEqual(['moved-1'])
  })

  it('grafts a recovery-authority tab and a pending activation spawn', () => {
    const recovering = namedTab('recover-1', worktreeId, null)
    const spawning = { ...namedTab('spawn-1', worktreeId, null), pendingActivationSpawn: true }
    const current = session({ [worktreeId]: [recovering, spawning] })
    const remote = session({ [worktreeId]: [] })

    const merged = mergeDirectSshRemoteWorkspaceSession(
      current,
      remote,
      new Set([worktreeId]),
      current.tabsByWorktree,
      new Set([directSshTerminalTabKey(worktreeId, 'recover-1')]),
      {},
      authority
    )

    expect(merged?.tabsByWorktree[worktreeId]?.map((entry) => entry.id)).toEqual([
      'recover-1',
      'spawn-1'
    ])
    expect(merged?.tabsByWorktree[worktreeId]?.[1]?.pendingActivationSpawn).toBeTruthy()
  })

  it('keeps local layout and session-id bindings over snapshot entries for a grafted id', () => {
    const live = namedTab('live-1', worktreeId, 'ssh:target-a@@pty-34')
    const current = session({ [worktreeId]: [live] })
    current.terminalLayoutsByTabId = {
      'live-1': {
        root: { type: 'leaf', leafId: 'leaf-a' },
        activeLeafId: 'leaf-a',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-a': 'ssh:target-a@@pty-34' }
      }
    }
    current.remoteSessionIdsByTabId = { 'live-1': 'ssh:target-a@@pty-34' }
    const remote = session({ [worktreeId]: [] })
    remote.terminalLayoutsByTabId = {
      'live-1': {
        root: { type: 'leaf', leafId: 'leaf-x' },
        activeLeafId: 'leaf-x',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-x': 'ssh:target-a@@forged' }
      }
    }
    remote.remoteSessionIdsByTabId = { 'live-1': 'ssh:target-a@@forged' }

    const merged = mergeDirectSshRemoteWorkspaceSession(
      current,
      remote,
      new Set([worktreeId]),
      current.tabsByWorktree,
      new Set(),
      {},
      authority
    )

    expect(merged?.terminalLayoutsByTabId['live-1']?.ptyIdsByLeafId).toEqual({
      'leaf-a': 'ssh:target-a@@pty-34'
    })
    expect(merged?.remoteSessionIdsByTabId).toEqual({ 'live-1': 'ssh:target-a@@pty-34' })
  })

  it('fails closed when the same id is graft-eligible under two replace-scope worktrees', () => {
    const worktreeB = 'repo-b::/work-b'
    const current = session({
      [worktreeId]: [namedTab('dup-1', worktreeId, 'ssh:target-a@@pty-1')],
      [worktreeB]: [namedTab('dup-1', worktreeB, 'ssh:target-a@@pty-2')]
    })
    const remote = session({})

    expect(
      mergeDirectSshRemoteWorkspaceSession(
        current,
        remote,
        new Set([worktreeId, worktreeB]),
        current.tabsByWorktree,
        new Set(),
        {},
        authority
      )
    ).toBeNull()
  })

  it('does not graft an id owned by a worktree outside the replace scope', () => {
    const outsideWorktree = 'repo-c::/work-c'
    const current = session({
      [worktreeId]: [namedTab('outside-1', worktreeId, 'ssh:target-a@@pty-1')]
    })
    const liveTabsByWorktree = {
      [worktreeId]: [namedTab('outside-1', worktreeId, 'ssh:target-a@@pty-1')],
      [outsideWorktree]: [namedTab('outside-1', outsideWorktree, null)]
    }
    const remote = session({ [worktreeId]: [] })

    const merged = mergeDirectSshRemoteWorkspaceSession(
      current,
      remote,
      new Set([worktreeId]),
      liveTabsByWorktree,
      new Set(),
      {},
      authority
    )

    expect(merged?.tabsByWorktree[worktreeId]).toEqual([])
  })

  it('keeps active-tab bookkeeping for a worktree reconstituted only by grafting', () => {
    const live = namedTab('live-1', worktreeId, 'ssh:target-a@@pty-34')
    const current = session({ [worktreeId]: [live] })
    current.activeWorktreeId = worktreeId
    current.activeTabId = 'live-1'
    current.activeTabIdByWorktree = { [worktreeId]: 'live-1' }
    const remote = session({})

    const merged = mergeDirectSshRemoteWorkspaceSession(
      current,
      remote,
      new Set([worktreeId]),
      current.tabsByWorktree,
      new Set(),
      {},
      authority
    )

    expect(merged?.activeWorktreeId).toBe(worktreeId)
    expect(merged?.activeTabId).toBe('live-1')
    expect(merged?.activeTabIdByWorktree?.[worktreeId]).toBe('live-1')
  })
})
