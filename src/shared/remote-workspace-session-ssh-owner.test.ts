import { expect, it } from 'vitest'
import { projectRemoteWorkspaceSshPtyOwner } from './remote-workspace-ssh-pty-owner'
import { getDefaultWorkspaceSession } from './constants'
import {
  exportRemoteWorkspaceSession,
  importRemoteWorkspaceSession
} from './remote-workspace-session-projection'
import { toAppSshPtyId, toRelaySshPtyId } from './ssh-pty-id'

it('imports a retained host session under the receiving client SSH target', () => {
  const oldPtyId = toAppSshPtyId('old-client-target', 'pty2:terminal:1')
  const oldWorktree = 'old-repo::/srv/project'
  const oldSession = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [oldWorktree]: [
        {
          id: 'tab',
          ptyId: oldPtyId,
          worktreeId: oldWorktree,
          title: 'Shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      tab: {
        root: null,
        activeLeafId: null,
        expandedLeafId: null,
        ptyIdsByLeafId: { leaf: oldPtyId }
      }
    },
    remoteSessionIdsByTabId: { tab: oldPtyId }
  }
  const snapshot = exportRemoteWorkspaceSession(oldSession, { isTargetWorktree: () => true })
  // Previously published snapshots contain the publishing client's target IDs.
  snapshot.tabsByWorktreePath['/srv/project'][0].ptyId = oldPtyId
  snapshot.terminalLayoutsByTabId.tab.ptyIdsByLeafId = { leaf: oldPtyId }
  snapshot.remoteSessionIdsByTabId = { tab: oldPtyId }
  const imported = importRemoteWorkspaceSession(snapshot, {
    executionHostId: 'ssh:new-client-target',
    resolveWorktreeId: () => 'new-repo::/srv/project'
  })
  const expected = toAppSshPtyId('new-client-target', 'pty2:terminal:1')
  expect(imported.tabsByWorktree['new-repo::/srv/project'][0].ptyId).toBe(expected)
  expect(imported.terminalLayoutsByTabId.tab.ptyIdsByLeafId?.leaf).toBe(expected)
  expect(imported.remoteSessionIdsByTabId?.tab).toBe(expected)
  expect(toRelaySshPtyId('new-client-target', expected)).toBe('pty2:terminal:1')
  expect(snapshot.tabsByWorktreePath['/srv/project'][0].ptyId).toBe(oldPtyId)
})

it.each([undefined, 'local', 'runtime:paired'] as const)(
  'preserves snapshot identities without a direct SSH import owner: %s',
  (executionHostId) => {
    const snapshot = {
      activeWorktreePath: null,
      activeTabId: null,
      tabsByWorktreePath: {},
      terminalLayoutsByTabId: {},
      remoteSessionIdsByTabId: { tab: toAppSshPtyId('old-target', 'pty-1') }
    }
    const imported = projectRemoteWorkspaceSshPtyOwner(snapshot, executionHostId)
    expect(imported).toBe(snapshot)
  }
)

it('preserves legacy, runtime, and malformed IDs while rebasing encoded SSH owners', () => {
  const ids = {
    legacy: 'pty-1',
    runtime: 'remote:paired@@pty-2',
    malformed: 'ssh:%zz@@pty-3',
    prior: toAppSshPtyId('old-client', 'pty2:leaf:4'),
    current: toAppSshPtyId('new/client', 'pty2:leaf:5')
  }
  const snapshot = {
    activeWorktreePath: null,
    activeTabId: null,
    tabsByWorktreePath: {},
    terminalLayoutsByTabId: {},
    remoteSessionIdsByTabId: ids
  }
  const imported = projectRemoteWorkspaceSshPtyOwner(snapshot, 'ssh:new%2Fclient')
  expect(imported.remoteSessionIdsByTabId).toEqual({
    ...ids,
    prior: toAppSshPtyId('new/client', 'pty2:leaf:4')
  })
  expect(snapshot.remoteSessionIdsByTabId.prior).toBe(toAppSshPtyId('old-client', 'pty2:leaf:4'))
})

it('publishes the same host session after either client imports it', () => {
  const hostSession = {
    activeWorktreePath: null,
    activeTabId: null,
    tabsByWorktreePath: {
      '/srv/project': [
        {
          id: 'tab',
          ptyId: toAppSshPtyId('client-a', 'pty-1'),
          worktreePath: '/srv/project',
          title: 'Shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {},
    remoteSessionIdsByTabId: { tab: toAppSshPtyId('client-a', 'pty-1') }
  }
  const republish = (target: string) =>
    exportRemoteWorkspaceSession(
      importRemoteWorkspaceSession(hostSession, {
        executionHostId: `ssh:${target}`,
        resolveWorktreeId: () => `${target}::/srv/project`
      }),
      { isTargetWorktree: () => true }
    )
  expect(republish('client-a')).toEqual(republish('client-b'))
})
