import { describe, expect, it } from 'vitest'
import {
  floatingWorkspaceId,
  floatingWorkspaceEnvironmentId
} from '../../../shared/floating-workspace-id'
import {
  getRuntimeEnvironmentIdForWorktree,
  getExecutionHostIdForWorktree
} from './worktree-runtime-owner'
import { resolveTerminalHostOwnership } from './terminal-worktree-route'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { projectFloatingSessionSnapshot } from '@/runtime/floating-session-snapshot'
import { useFloatingWorkspaceHost, getSelectedFloatingWorkspaceId } from './floating-workspace-host'

const local = 'global-floating-terminal'
const state = { settings: { activeRuntimeEnvironmentId: 'other-host' } }

describe('floating workspace host ownership', () => {
  it('keeps Local local and encodes the selected remote owner independently of sidebar focus', () => {
    const remote = floatingWorkspaceId('host:/one')
    expect(floatingWorkspaceEnvironmentId(remote)).toBe('host:/one')
    expect(getRuntimeEnvironmentIdForWorktree(state, local)).toBeNull()
    expect(getExecutionHostIdForWorktree(state, remote)).toBe('runtime:host%3A%2Fone')
    expect(getRuntimeEnvironmentIdForWorktree(state, remote)).toBe('host:/one')
    expect(resolveTerminalHostOwnership(state, remote, 'spawn')).toEqual({
      kind: 'runtime',
      runtimeEnvironmentId: 'host:/one'
    })
    expect(resolveTerminalHostOwnership(state, remote, 'teardown')).toEqual({
      kind: 'runtime',
      runtimeEnvironmentId: 'host:/one'
    })
    expect(toRuntimeWorktreeSelector(remote)).toBe('id:global-floating-terminal')
  })

  it('switches only the selected namespace without retiring any tabs', () => {
    useFloatingWorkspaceHost.getState().selectHost('one')
    expect(getSelectedFloatingWorkspaceId()).toBe(floatingWorkspaceId('one'))
    useFloatingWorkspaceHost.getState().selectHost(null)
    expect(getSelectedFloatingWorkspaceId()).toBe(local)
  })

  it('projects floating publications without changing host tab and pane identities', () => {
    const snapshot = {
      worktree: local,
      publicationEpoch: 'epoch',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    }
    expect(projectFloatingSessionSnapshot(snapshot, 'one')).toEqual({
      ...snapshot,
      worktree: floatingWorkspaceId('one')
    })
    expect(snapshot.worktree).toBe(local)
    const folder = { ...snapshot, worktree: 'folder:remote-project' }
    expect(projectFloatingSessionSnapshot(folder, 'one')).toBe(folder)
  })
})
