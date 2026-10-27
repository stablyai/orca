// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { resolveWorkspaceCreationTarget } from '@/lib/project-host-workspace-target'
import * as decisions from './composer-decisions'
import { useComposerInitialTargetState } from './initial-target-state'

const currentRepo: Repo = {
  id: 'current',
  path: '/current',
  displayName: 'Current',
  badgeColor: '',
  addedAt: 0
}
const mappedRepo: Repo = { ...currentRepo, id: 'mapped', path: '/mapped' }
const jiraSourceContext = {
  kind: 'task-source' as const,
  provider: 'jira' as const,
  projectId: 'repo:current',
  hostId: 'local' as const
}

function createInput(repos: Repo[]): Parameters<typeof useComposerInitialTargetState>[0] {
  const projection = projectHostSetupProjectionFromRepos(repos)
  return {
    actionableHostIds: new Set(['local', 'ssh:builder']),
    decisions,
    eligibleRepos: repos,
    initialProjectGroupId: undefined,
    initialRepoId: 'mapped',
    initialTaskSourceContext: jiraSourceContext,
    initialWorkspaceTarget: null,
    initialWorkspaceStatus: undefined,
    newWorkspaceDraft: null,
    persistDraft: false,
    projectGroups: [],
    projectHostSetups: projection.setups,
    projects: projection.projects,
    repoIdOverride: undefined,
    seedActiveRepoId: 'current',
    workspaceHostScope: 'all',
    workspaceStatuses: []
  }
}

afterEach(cleanup)

describe('Jira mapped workspace creation target', () => {
  it('selects the mapped repository while retaining the unrelated Tasks source context', () => {
    const input = createInput([currentRepo, mappedRepo])
    const { result } = renderHook(() =>
      useComposerInitialTargetState({
        ...input,
        initialWorkspaceTarget: { projectId: 'repo:mapped', hostId: 'local' }
      })
    )

    expect(result.current.resolvedInitialWorkspaceTarget).toMatchObject({
      status: 'ready',
      target: { repoId: 'mapped', hostId: 'local' }
    })
    expect(input.initialTaskSourceContext).toEqual(jiraSourceContext)
  })

  it('uses the mapped SSH execution host while Jira account ownership remains local', () => {
    const sshRepo: Repo = { ...mappedRepo, connectionId: 'builder' }
    const input = createInput([currentRepo, sshRepo])
    const { result } = renderHook(() =>
      useComposerInitialTargetState({
        ...input,
        initialWorkspaceTarget: { projectId: 'repo:mapped', hostId: 'ssh:builder' }
      })
    )

    expect(result.current.resolvedInitialWorkspaceTarget).toMatchObject({
      status: 'ready',
      target: { repoId: 'mapped', hostId: 'ssh:builder', repo: sshRepo }
    })
    expect(input.initialTaskSourceContext?.hostId).toBe('local')
  })

  it('preserves a selected execution host when setup IDs repeat across hosts', () => {
    const sshRepo: Repo = { ...currentRepo, connectionId: 'builder', path: '/remote/current' }
    const input = createInput([currentRepo, sshRepo])
    const { result } = renderHook(() =>
      useComposerInitialTargetState({
        ...input,
        initialWorkspaceTarget: { projectId: 'repo:current', hostId: 'ssh:builder' }
      })
    )

    const runtimeTarget = resolveWorkspaceCreationTarget({
      eligibleRepos: input.eligibleRepos,
      projects: input.projects,
      projectHostSetups: input.projectHostSetups,
      draftRepoId: result.current.repoId,
      projectHostSetupId: result.current.selectedProjectHostSetupOverrideId,
      projectHostSetupHostId: result.current.selectedProjectHostSetupOverrideHostId
    })
    expect(runtimeTarget).toMatchObject({
      status: 'ready',
      target: { hostId: 'ssh:builder', repo: sshRepo }
    })
  })
})
