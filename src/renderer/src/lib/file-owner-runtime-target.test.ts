import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import {
  getRuntimeTargetForFileOwner,
  getRuntimeTargetForWorktreeOwner,
  requireRuntimeTargetForFileOwner
} from './file-owner-runtime-target'
import type { WorktreeOperationRouteState } from './worktree-operation-route'

const settings = { activeRuntimeEnvironmentId: 'focused-env' }

const state: WorktreeOperationRouteState = {
  settings,
  repos: [
    { id: 'local-repo', connectionId: null, executionHostId: 'local' },
    { id: 'runtime-repo', connectionId: null, executionHostId: 'runtime:owner-env' },
    { id: 'ssh-repo', connectionId: 'box', executionHostId: 'ssh:box' }
  ],
  worktreesByRepo: {
    'local-repo': [{ id: 'local-repo::wt-a', repoId: 'local-repo', hostId: 'local' }],
    'runtime-repo': [
      {
        id: 'runtime-repo::wt-b',
        repoId: 'runtime-repo',
        hostId: 'runtime:owner-env',
        runtimeOwnerEnvironmentId: 'owner-env'
      }
    ],
    'ssh-repo': [{ id: 'ssh-repo::wt-c', repoId: 'ssh-repo', hostId: 'ssh:box' }]
  }
}

describe('getRuntimeTargetForWorktreeOwner', () => {
  it('dials the owner while another server is focused', () => {
    expect(getRuntimeTargetForWorktreeOwner(state, 'runtime-repo::wt-b')).toEqual({
      kind: 'environment',
      environmentId: 'owner-env'
    })
    expect(getRuntimeTargetForWorktreeOwner(state, 'local-repo::wt-a')).toEqual({ kind: 'local' })
    expect(getRuntimeTargetForWorktreeOwner(state, 'ssh-repo::wt-c')).toEqual({ kind: 'local' })
    expect(getRuntimeTargetForWorktreeOwner(state, FLOATING_TERMINAL_WORKTREE_ID)).toEqual({
      kind: 'local'
    })
  })

  it('reads an unstamped legacy row as this app, not the focused server', () => {
    // Before: a single saved, focused server claimed rows that predate owner stamping.
    const legacy: WorktreeOperationRouteState = {
      settings,
      runtimeEnvironments: [{ id: 'focused-env' }],
      runtimeEnvironmentCatalogHydrated: true,
      repos: [{ id: 'legacy-repo' }],
      worktreesByRepo: { 'legacy-repo': [{ id: 'legacy-repo::wt', repoId: 'legacy-repo' }] }
    }
    expect(getRuntimeTargetForWorktreeOwner(legacy, 'legacy-repo::wt')).toEqual({ kind: 'local' })
  })

  it('stays on this app for no workspace or a workspace with no row yet', () => {
    expect(getRuntimeTargetForWorktreeOwner(state, null)).toEqual({ kind: 'local' })
    expect(getRuntimeTargetForWorktreeOwner(state, 'unknown::wt')).toEqual({ kind: 'local' })
  })

  it('has no transport when rows disagree, and a caller with an error path refuses', () => {
    const ambiguous: WorktreeOperationRouteState = {
      settings,
      worktreesByRepo: {
        a: [
          {
            id: 'dup::wt',
            repoId: 'a',
            hostId: 'runtime:env-a',
            runtimeOwnerEnvironmentId: 'env-a'
          }
        ],
        b: [
          {
            id: 'dup::wt',
            repoId: 'b',
            hostId: 'runtime:env-b',
            runtimeOwnerEnvironmentId: 'env-b'
          }
        ]
      }
    }
    expect(getRuntimeTargetForWorktreeOwner(ambiguous, 'dup::wt')).toBeNull()
    expect(() => requireRuntimeTargetForFileOwner(ambiguous, 'dup::wt', undefined)).toThrow(
      "Couldn't verify which host owns this file"
    )
  })
})

describe('getRuntimeTargetForFileOwner', () => {
  it("keeps the tab's stamped owner, else the worktree's owner", () => {
    expect(getRuntimeTargetForFileOwner(state, 'local-repo::wt-a', 'stamped-env')).toEqual({
      kind: 'environment',
      environmentId: 'stamped-env'
    })
    expect(getRuntimeTargetForFileOwner(state, 'runtime-repo::wt-b', null)).toEqual({
      kind: 'local'
    })
    expect(getRuntimeTargetForFileOwner(state, 'runtime-repo::wt-b', undefined)).toEqual({
      kind: 'environment',
      environmentId: 'owner-env'
    })
  })
})
