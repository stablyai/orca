// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { resolveWorkspaceCreationTarget } from '@/lib/project-host-workspace-target'
import * as decisions from './composer-decisions'
import { useComposerInitialTargetState } from './initial-target-state'

const checkoutA: Repo = {
  id: 'checkout-a',
  path: '/repos/app',
  displayName: 'App',
  badgeColor: '',
  addedAt: 0,
  gitRemoteIdentity: {
    canonicalKey: 'github.com/acme/app',
    remoteName: 'origin',
    remoteUrl: 'https://github.com/acme/app.git'
  }
}
const checkoutB: Repo = { ...checkoutA, id: 'checkout-b', path: '/repos/app-copy' }

type Input = Parameters<typeof useComposerInitialTargetState>[0]

function createInput(repos: Repo[] = [checkoutA, checkoutB]): Input {
  const projection = projectHostSetupProjectionFromRepos(repos)
  return {
    projects: projection.projects,
    projectHostSetups: projection.setups,
    eligibleRepos: repos,
    actionableHostIds: new Set(['local']),
    hostOptions: [],
    decisions,
    initialProjectGroupId: undefined,
    initialRepoId: undefined,
    initialTaskSourceContext: null,
    initialWorkspaceTarget: null,
    initialWorkspaceStatus: undefined,
    newWorkspaceDraft: null,
    persistDraft: false,
    projectGroups: [],
    repoIdOverride: undefined,
    seedActiveRepoId: null,
    workspaceHostScope: 'all',
    workspaceStatuses: []
  }
}

function createDraft(): NonNullable<Input['newWorkspaceDraft']> {
  return {
    repoId: checkoutB.id,
    name: '',
    prompt: '',
    note: '',
    attachments: [],
    linkedWorkItem: null,
    agent: 'claude',
    linkedIssue: '',
    linkedPR: null
  }
}

afterEach(cleanup)

describe('initial checkout choice', () => {
  it.each([
    [checkoutA, checkoutB],
    [checkoutB, checkoutA]
  ])(
    'requires a choice without explicit checkout context, regardless of catalog order',
    (...repos) => {
      const { result } = renderHook(() => useComposerInitialTargetState(createInput(repos)))

      expect(result.current.resolvedInitialWorkspaceTarget.status).toBe('ambiguous')
      expect(result.current.repoId).toBe('')
      expect(result.current.pendingInitialWorkspaceTarget).toMatchObject({
        projectId: createInput().projects[0].id,
        projectHostSetupId: null
      })
    }
  )

  it.each(['active', 'initial', 'draft'] as const)(
    'preserves explicit %s checkout authority',
    (source) => {
      const input = createInput()
      if (source === 'active') {
        input.seedActiveRepoId = checkoutB.id
      }
      if (source === 'initial') {
        input.initialRepoId = checkoutB.id
      }
      if (source === 'draft') {
        input.persistDraft = true
        input.newWorkspaceDraft = createDraft()
        input.seedActiveRepoId = checkoutA.id
      }
      const { result } = renderHook(() => useComposerInitialTargetState(input))

      expect(result.current.resolvedInitialWorkspaceTarget).toMatchObject({
        status: 'ready',
        target: { repoId: checkoutB.id, setup: { path: checkoutB.path } }
      })
      expect(result.current.repoId).toBe(checkoutB.id)
    }
  )

  it('keeps a sole ready checkout actionable when a pending duplicate precedes it', () => {
    const input = createInput([checkoutB])
    input.persistDraft = true
    input.newWorkspaceDraft = createDraft()
    input.projectHostSetups = [
      { ...input.projectHostSetups[0], id: 'pending-b', setupState: 'setting-up' },
      ...input.projectHostSetups
    ]
    const { result } = renderHook(() => useComposerInitialTargetState(input))

    expect(result.current.resolvedInitialWorkspaceTarget).toMatchObject({
      status: 'ready',
      target: { repoId: checkoutB.id, projectHostSetupId: checkoutB.id }
    })
  })

  it('preserves an explicit checkout when accompanied by its project and host hint', () => {
    const input = createInput()
    input.initialRepoId = checkoutB.id
    input.initialWorkspaceTarget = { projectId: input.projects[0].id, hostId: 'local' }
    const { result } = renderHook(() => useComposerInitialTargetState(input))

    expect(result.current.resolvedInitialWorkspaceTarget).toMatchObject({
      status: 'ready',
      target: { repoId: checkoutB.id, setup: { path: checkoutB.path } }
    })
  })

  it('retains an unavailable initial repository instead of enabling automatic repair to a sibling', () => {
    const input = createInput()
    input.initialRepoId = checkoutB.id
    input.projectHostSetups = input.projectHostSetups.map((setup) =>
      setup.repoId === checkoutB.id ? { ...setup, setupState: 'setting-up' } : setup
    )
    const { result } = renderHook(() => useComposerInitialTargetState(input))

    expect(result.current.resolvedInitialWorkspaceTarget.status).toBe('unavailable')
    expect(result.current.repoId).toBe(checkoutB.id)
    expect(
      resolveWorkspaceCreationTarget({ ...input, draftRepoId: result.current.repoId })
    ).toMatchObject({ status: 'unavailable' })
  })

  it('retains a removed exact setup from a persisted draft until the user replaces it', () => {
    const input = createInput()
    input.persistDraft = true
    input.newWorkspaceDraft = {
      ...createDraft(),
      projectId: input.projects[0].id,
      hostId: 'local',
      projectHostSetupId: 'removed'
    }
    const { result } = renderHook(() => useComposerInitialTargetState(input))

    expect(result.current.resolvedInitialWorkspaceTarget.status).toBe('unavailable')
    expect(result.current.pendingInitialWorkspaceTarget).toMatchObject({
      projectHostSetupId: 'removed'
    })
  })
})
