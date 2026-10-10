import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { createWorktreeIdentity } from '../../../shared/worktree/identity'
import type { Repo } from '../../../shared/repo-types'
import { makeWorktree } from '../store/slices/worktrees-slice-test-fixtures'
import { withRepoHostOwnership } from '../store/slices/worktrees/listing/worktree-host-ownership'
import { repoWithFetchedOwner } from '../store/repos/owner-routing'
import { worktreeSelectionOwnerForRow } from '../lib/worktree-selection-owner'
import { resolveWorktreeOperationRouteResult } from '../lib/worktree-operation-route'
import {
  selectEditorExternalWatchTargets,
  type EditorExternalWatchTargetState
} from '../hooks/editor-external-watch-targets'

const id = 'repo1::/same/path'
const publisher = 'gpu'
const target = { kind: 'environment', environmentId: publisher } as const
const repos = (['a', 'b'] as const).map((suffix) => {
  const raw: Repo = {
    id: 'repo1',
    path: '/repo',
    displayName: suffix,
    badgeColor: 'blue',
    addedAt: 1,
    executionHostId: `ssh:${suffix}`,
    connectionId: suffix
  }
  return repoWithFetchedOwner(raw, target)
})
const rows = (['a', 'b'] as const).map((suffix) =>
  withRepoHostOwnership(
    makeWorktree({
      id,
      repoId: 'repo1',
      path: '/same/path',
      hostId: `ssh:${suffix}`,
      instanceId: `instance-${suffix}`,
      identity: createWorktreeIdentity({
        worktreeId: id,
        executionHostId: `ssh:${suffix}`,
        instanceId: `instance-${suffix}`
      })
    }),
    'runtime:gpu'
  )
)
const selected = rows[1]!
const owner = worktreeSelectionOwnerForRow(selected, repos)!

function stateFor(currentRows = rows): EditorExternalWatchTargetState {
  return {
    settings: getDefaultSettings('/home/me'),
    openFiles: [],
    activeWorktreeId: id,
    activeWorkspaceExecutionHostId: 'ssh:b',
    activeWorkspaceOwner: owner,
    repos,
    worktreesByRepo: { repo1: currentRows },
    folderWorkspaces: [],
    projectGroups: [],
    rightSidebarOpen: true,
    rightSidebarTab: 'explorer',
    rightSidebarExplorerView: 'files',
    gitStatusHugeByWorktree: {},
    sshConnectionStates: new Map()
  }
}

describe('checked sidebar watch ownership', () => {
  it('single private host control uses the captured paired route', () => {
    const state = { ...stateFor([selected]), repos: [repos[1]!] }
    const output = {
      route: resolveWorktreeOperationRouteResult(state, id),
      targets: selectEditorExternalWatchTargets(state).targets
    }
    expect(output.targets).toEqual([
      expect.objectContaining({ runtimeEnvironmentId: publisher, connectionId: 'b' })
    ])
  })

  it.each([false, true])(
    'two private hosts select B independent of catalog order (B first %s)',
    (first) => {
      const state = stateFor(first ? [selected, rows[0]!] : rows)
      const output = {
        owner,
        route: resolveWorktreeOperationRouteResult(state, id),
        targets: selectEditorExternalWatchTargets(state).targets
      }
      expect(output.targets).toEqual([
        expect.objectContaining({ runtimeEnvironmentId: publisher, connectionId: 'b' })
      ])
    }
  )

  it('a stale captured instance refuses the sidebar watch', () => {
    const replacement = {
      ...selected,
      instanceId: 'replacement-b',
      identity: createWorktreeIdentity({
        worktreeId: id,
        executionHostId: 'ssh:b',
        instanceId: 'replacement-b'
      })
    }
    const state = stateFor([rows[0]!, replacement])
    const output = {
      owner,
      route: resolveWorktreeOperationRouteResult(state, id),
      targets: selectEditorExternalWatchTargets(state).targets
    }
    expect(output.route).toEqual({ kind: 'missing' })
    expect(output.targets).toEqual([])
  })

  it('uses the selected repository connection for the Source Control watch gate', () => {
    const state = stateFor()
    state.rightSidebarTab = 'source-control'
    state.sshConnectionStates = new Map([
      ['b', { targetId: 'b', status: 'connected', error: null, reconnectAttempt: 0 }]
    ])
    expect(selectEditorExternalWatchTargets(state).targets).toEqual([
      expect.objectContaining({ runtimeEnvironmentId: publisher, connectionId: 'b' })
    ])
  })

  it('retains an explicit editor watch when the sidebar owner is stale', () => {
    const state = stateFor([rows[0]!])
    state.openFiles = [
      {
        id: 'file-a',
        worktreeId: id,
        filePath: '/same/path/file',
        relativePath: 'file',
        language: 'text',
        mode: 'edit',
        isDirty: false,
        runtimeEnvironmentId: publisher,
        externalSshTargetId: 'a'
      }
    ]
    expect(selectEditorExternalWatchTargets(state).targets).toEqual([
      expect.objectContaining({ runtimeEnvironmentId: publisher, connectionId: 'a' })
    ])
  })
})
