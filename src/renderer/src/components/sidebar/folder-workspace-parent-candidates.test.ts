import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { createWorktreeIdentity } from '../../../../shared/worktree/identity'
import { makeWorktree, makeRepo } from '../worktree-jump-palette-test-fixtures'
import {
  captureFolderParentContext,
  getEligibleFolderWorkspaceParents,
  type FolderParentCatalog,
  type FolderParentContext
} from './folder-workspace-parent-candidates'

const group: ProjectGroup = {
  id: 'group',
  name: 'Folder group',
  parentPath: '/repo',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0
}
function folder(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder',
    projectGroupId: group.id,
    name: 'Ticket',
    folderPath: '/repo',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
    executionHostId: 'local',
    ...overrides
  }
}
function child(host: ExecutionHostId = 'local', environmentId?: string) {
  const id = 'repo-1::/repo/child'
  return makeWorktree(id, 'Child', {
    hostId: environmentId ? `runtime:${environmentId}` : host,
    runtimeOwnerEnvironmentId: environmentId,
    instanceId: 'child-instance',
    identity: createWorktreeIdentity({
      worktreeId: id,
      executionHostId: host,
      instanceId: 'child-instance'
    })
  })
}
function context(host: ExecutionHostId = 'local', environmentId?: string): FolderParentContext {
  const captured = captureFolderParentContext({ repos: [makeRepo()] }, child(host, environmentId))
  if (!captured) {
    throw new Error('Expected captured owner')
  }
  return captured
}
function catalog(overrides: Partial<FolderParentCatalog> = {}): FolderParentCatalog {
  return {
    target: { kind: 'local' },
    folderWorkspaces: [folder()],
    projectGroups: [group],
    repos: [],
    ...overrides
  }
}

describe('folder parent candidates', () => {
  it('captures immutable identity rather than the focused runtime', () => {
    const captured = context('local', 'env-a')
    expect(captured.target).toEqual({ kind: 'environment', environmentId: 'env-a' })
    expect(captured.selector).toBe(`identity:${child('local', 'env-a').identity?.key}`)
  })
  it('refuses missing, mismatched or forged checkout identity', () => {
    const current = child()
    expect(captureFolderParentContext({}, { ...current, identity: undefined })).toBeNull()
    expect(captureFolderParentContext({}, { ...current, instanceId: 'replacement' })).toBeNull()
    const identity = current.identity
    if (!identity) {
      throw new Error('Expected fixture identity')
    }
    expect(
      captureFolderParentContext({}, { ...current, identity: { ...identity, key: 'forged' } })
    ).toBeNull()
  })
  it('offers local folders without Git parent candidates or membership edits', () => {
    expect(
      getEligibleFolderWorkspaceParents(context(), catalog()).map((row) => row.folder.id)
    ).toEqual(['folder'])
  })
  it('offers a same-host folder in another group and includes group/path search context', () => {
    const result = getEligibleFolderWorkspaceParents(context(), catalog())
    expect(result[0].searchText).toBe('Ticket Folder group /repo')
  })
  it('excludes archived folders and missing group ownership', () => {
    expect(
      getEligibleFolderWorkspaceParents(
        context(),
        catalog({ folderWorkspaces: [folder({ isArchived: true })] })
      )
    ).toEqual([])
    expect(getEligibleFolderWorkspaceParents(context(), catalog({ projectGroups: [] }))).toEqual([])
  })
  it('keeps SSH attachment within the exact target', () => {
    const matching = folder({ executionHostId: 'ssh:build', connectionId: 'build' })
    expect(
      getEligibleFolderWorkspaceParents(
        context('ssh:build'),
        catalog({ folderWorkspaces: [matching] })
      )
    ).toHaveLength(1)
    expect(
      getEligibleFolderWorkspaceParents(
        context('ssh:other'),
        catalog({ folderWorkspaces: [matching] })
      )
    ).toEqual([])
    expect(
      getEligibleFolderWorkspaceParents(context(), catalog({ folderWorkspaces: [matching] }))
    ).toEqual([])
  })
  it('compares paired runtime namespace separately from server-local execution', () => {
    const ctx = context('local', 'env-a')
    const owned = catalog({
      target: ctx.target,
      folderWorkspaces: [folder({ executionHostId: 'runtime:env-a' })]
    })
    expect(getEligibleFolderWorkspaceParents(ctx, owned)).toHaveLength(1)
    expect(
      getEligibleFolderWorkspaceParents(ctx, {
        ...owned,
        target: { kind: 'environment', environmentId: 'env-b' }
      })
    ).toEqual([])
    expect(
      getEligibleFolderWorkspaceParents(ctx, {
        ...owned,
        folderWorkspaces: [folder({ executionHostId: 'runtime:env-b' })]
      })
    ).toEqual([])
  })
  it('resolves nested SSH execution beneath a paired runtime stamp', () => {
    const ctx = context('ssh:build', 'env-a')
    expect(
      getEligibleFolderWorkspaceParents(
        ctx,
        catalog({
          target: ctx.target,
          folderWorkspaces: [folder({ executionHostId: 'runtime:env-a', connectionId: 'build' })]
        })
      )
    ).toHaveLength(1)
  })
  it('does not select ambiguous same-ID folder records', () => {
    expect(
      getEligibleFolderWorkspaceParents(
        context(),
        catalog({ folderWorkspaces: [folder(), folder()] })
      )
    ).toEqual([])
  })
  it('rejects a folder whose registered members span execution hosts', () => {
    const local = { ...makeRepo(), projectGroupId: group.id }
    const remote = {
      ...makeRepo(),
      id: 'remote',
      projectGroupId: group.id,
      executionHostId: 'ssh:build' as const
    }
    expect(
      getEligibleFolderWorkspaceParents(context(), catalog({ repos: [local, remote] }))
    ).toEqual([])
  })
  it('marks the current parent only for the captured checkout instance', () => {
    const ctx = context()
    const edge = {
      childWorkspaceKey: `worktree:${ctx.worktreeId}` as const,
      childInstanceId: ctx.instanceId,
      parentWorkspaceKey: 'folder:folder' as const,
      origin: 'manual' as const,
      capture: { source: 'manual-action' as const, confidence: 'explicit' as const },
      createdAt: 0
    }
    expect(
      getEligibleFolderWorkspaceParents(ctx, catalog(), { [edge.childWorkspaceKey]: edge })[0]
        .isCurrent
    ).toBe(true)
    expect(
      getEligibleFolderWorkspaceParents(ctx, catalog(), {
        [edge.childWorkspaceKey]: { ...edge, childInstanceId: 'stale' }
      })[0].isCurrent
    ).toBe(false)
  })
})
