import { describe, expect, it } from 'vitest'
import { hostWorktreeTarget } from '../../../../../../shared/worktree/host-qualified-identity'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { DetectedWorktreeListResult } from '../../../../../../shared/worktree/types'
import {
  applyDetectedWorktreeUpdates,
  folderWorkspaceMatchesHost,
  findKnownWorktreeById
} from './detected-worktree-meta'
import {
  makeFolderWorkspace,
  makeProjectGroup
} from '../../../../components/sidebar/folder-workspace-composer-submit-fixtures'
import { findFolderWorkspaceOwner } from '@/lib/folder-workspace-runtime-owner'
import { selectWorkspaceByHostTarget } from '../../../workspace-record-selectors'
import { resolveWorkspaceDirectory } from '@/lib/workspace-directory'
import { resolveQualifiedFolderWorkspaceResult } from '../../../../../../shared/folder-workspace-execution-host'
import type { Repo } from '../../../../../../shared/repo-types'
import { findIndexedFolderWorkspaceOwner } from '@/lib/worktree-runtime-owner-index'
import { folderWorkspaceToWorktree } from '../../../../../../shared/folder-workspace-worktree'
import { resolveNotificationTabOwner } from '@/attention/notification-subject-owner'
import { getWorktreeDeleteStateKey } from '../teardown/worktree-delete-state'

describe('inherited folder consumer identity', () => {
  it.each([false, true])(
    'keeps physical twins qualified through native owner, store and directory, reversed=%s',
    (reverse) => {
      const inherited = makeFolderWorkspace({
        id: 'same',
        projectGroupId: 'inherited',
        folderPath: '/remote'
      })
      const local = makeFolderWorkspace({
        id: 'same',
        executionHostId: 'local',
        folderPath: '/local'
      })
      const folderWorkspaces = reverse ? [inherited, local] : [local, inherited]
      const state = {
        folderWorkspaces,
        projectGroups: [{ id: 'inherited', executionHostId: 'ssh:box' as const }],
        repos: [],
        worktreesByRepo: {},
        detectedWorktreesByRepo: {},
        floatingWorkspacePath: null
      }
      const raw = findIndexedFolderWorkspaceOwner(folderWorkspaces, 'same', 'ssh:box')
      const converted = folderWorkspaceToWorktree(inherited)
      const notification = resolveNotificationTabOwner(state, {
        worktreeId: 'folder:same',
        executionHostId: 'ssh:box'
      })
      expect(resolveQualifiedFolderWorkspaceResult(state, 'same', 'ssh:box').kind).toBe('selected')
      expect(findFolderWorkspaceOwner(state, 'same', 'ssh:box')).toBe(inherited)
      const projected = findKnownWorktreeById(state, 'folder:same', 'ssh:box')
      expect(projected).toMatchObject({ path: '/remote', hostId: 'ssh:box' })
      expect(
        selectWorkspaceByHostTarget(
          state,
          hostWorktreeTarget({ id: 'folder:same', hostId: 'ssh:box' })
        )
      ).toBe(projected)
      expect(resolveWorkspaceDirectory(state, 'folder:same', 'ssh:box')).toBe('/remote')
      expect(findKnownWorktreeById(state, 'folder:same')).toBeUndefined()
      expect(findIndexedFolderWorkspaceOwner(folderWorkspaces, 'same', 'ssh:box')).toBe(raw)
      expect(folderWorkspaceToWorktree(inherited)).toEqual(converted)
      expect(
        resolveNotificationTabOwner(state, {
          worktreeId: 'folder:same',
          executionHostId: 'ssh:box'
        })
      ).toEqual(notification)
      expect(inherited.executionHostId).toBeUndefined()
      expect(getWorktreeDeleteStateKey(state, 'folder:same', 'ssh:box')).not.toBe(
        getWorktreeDeleteStateKey(state, 'folder:same', 'local')
      )
    }
  )
  it.each(['group', 'repo'])(
    'invalidates only a changed derived host projection from its %s catalog',
    (source) => {
      const folder = makeFolderWorkspace()
      const repo: Repo = {
        id: 'repo',
        path: '/repo/platform/hi/repo',
        projectGroupId: folder.projectGroupId,
        displayName: 'Repo',
        addedAt: 1,
        badgeColor: 'blue',
        kind: 'git'
      }
      const initial = {
        folderWorkspaces: [folder],
        projectGroups: [makeProjectGroup()],
        repos: [repo],
        worktreesByRepo: {},
        detectedWorktreesByRepo: {},
        floatingWorkspacePath: null
      }
      const first = findKnownWorktreeById(initial, `folder:${folder.id}`)
      expect(first?.hostId).toBe('local')
      expect(findKnownWorktreeById({ ...initial }, `folder:${folder.id}`)).toBe(first)
      const next =
        source === 'group'
          ? {
              ...initial,
              projectGroups: [{ ...makeProjectGroup(), executionHostId: 'ssh:box' as const }]
            }
          : { ...initial, repos: [{ ...repo, executionHostId: 'ssh:box' as const }] }
      expect(resolveQualifiedFolderWorkspaceResult(next, folder.id).kind).toBe('selected')
      const changed = findKnownWorktreeById(next, `folder:${folder.id}`)
      expect(changed?.hostId).toBe('ssh:box')
      expect(changed).not.toBe(first)
      expect(findKnownWorktreeById(next, `folder:${folder.id}`)).toBe(changed)
    }
  )
})

describe('folderWorkspaceMatchesHost', () => {
  it('prefers the host stamp, then the connection id, then local', () => {
    type Row = Pick<FolderWorkspace, 'connectionId' | 'executionHostId'>
    const ssh: Row = { executionHostId: 'ssh:target-1', connectionId: null }
    expect(folderWorkspaceMatchesHost(ssh, 'ssh:target-1')).toBe(true)
    expect(folderWorkspaceMatchesHost(ssh, 'local')).toBe(false)
    const stamped: Row = { executionHostId: 'runtime:env-1', connectionId: 'target-1' }
    expect(folderWorkspaceMatchesHost(stamped, 'runtime:env-1')).toBe(true)
    expect(folderWorkspaceMatchesHost(stamped, 'ssh:target-1')).toBe(false)
    const legacy: Row = { executionHostId: undefined, connectionId: 'target-1' }
    expect(folderWorkspaceMatchesHost(legacy, 'ssh:target-1')).toBe(true)
    expect(folderWorkspaceMatchesHost({ connectionId: '  ' }, 'local')).toBe(true)
    expect(folderWorkspaceMatchesHost({ connectionId: null }, 'local')).toBe(true)
  })
})

describe('applyDetectedWorktreeUpdates display-name provenance', () => {
  it('projects pinning changes into detected rows', () => {
    const detected = {
      id: 'repo-1::/workspace/feature',
      displayName: 'feature',
      displayNameMode: 'automatic',
      repoId: 'repo-1',
      branch: 'refs/heads/feature'
    }
    const state = {
      'repo-1': {
        repoId: 'repo-1',
        authoritative: true,
        source: 'git',
        worktrees: [detected]
      }
    } as unknown as Record<string, DetectedWorktreeListResult>

    const fixed = applyDetectedWorktreeUpdates(state, detected.id, {
      displayName: 'Agent workspace',
      displayNameIsPinned: true
    })
    expect(fixed['repo-1']?.worktrees[0]).toMatchObject({
      displayName: 'Agent workspace',
      displayNameMode: 'fixed'
    })

    const automatic = applyDetectedWorktreeUpdates(state, detected.id, {
      displayName: '',
      displayNameIsPinned: false
    })
    expect(automatic['repo-1']?.worktrees[0]).toMatchObject({
      displayName: 'feature',
      displayNameMode: 'automatic'
    })
  })

  it('keeps text until the host resolves a detached fallback', () => {
    const detached = {
      id: 'repo-1::/workspace/feature',
      displayName: 'Agent workspace',
      displayNameMode: 'fixed' as const,
      repoId: 'repo-1',
      branch: ''
    }
    const detachedState = {
      'repo-1': {
        repoId: 'repo-1',
        authoritative: true,
        source: 'git',
        worktrees: [detached]
      }
    } as unknown as Record<string, DetectedWorktreeListResult>

    const automatic = applyDetectedWorktreeUpdates(detachedState, detached.id, {
      displayName: '',
      displayNameIsPinned: false
    })

    expect(automatic['repo-1']?.worktrees[0]).toMatchObject({
      displayName: 'Agent workspace',
      displayNameMode: 'automatic'
    })
  })
})
