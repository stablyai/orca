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
