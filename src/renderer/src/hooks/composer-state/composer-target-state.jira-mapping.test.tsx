// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/repo-types'
import { EMPTY_RETIRED_NAME_REGISTRY } from '../../../../shared/worktree/retired-name-registry'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { normalizeTaskSourceContext } from '../../../../shared/task-source-context'
import {
  getRepoWorkspaceCreationTargetHint,
  type WorkspaceCreationTargetHint
} from '@/lib/project-host-workspace-target'
import * as decisions from './composer-decisions'
import { useComposerTargetState } from './composer-target-state'
import { useComposerExternalSync } from './composer-external-sync'
import { useComposerSourceState } from './composer-source-state'

const originalState = useAppStore.getState()
let originalApi: PropertyDescriptor | undefined
const currentRepo: Repo = {
  id: 'current',
  path: '/current',
  displayName: 'Current',
  kind: 'folder',
  badgeColor: '',
  addedAt: 0
}
const jiraSource = normalizeTaskSourceContext({
  provider: 'jira',
  projectId: 'repo:current',
  hostId: 'local',
  providerIdentity: {
    provider: 'jira',
    siteId: 'site',
    siteUrl: 'https://jira.example.invalid',
    projectKey: 'APP'
  }
})

beforeEach(() => {
  originalApi = Object.getOwnPropertyDescriptor(window, 'api')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      preflight: {
        detectAgents: vi.fn<Window['api']['preflight']['detectAgents']>().mockResolvedValue([])
      },
      worktrees: {
        listRetiredNames: vi
          .fn<Window['api']['worktrees']['listRetiredNames']>()
          .mockResolvedValue(EMPTY_RETIRED_NAME_REGISTRY)
      }
    }
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(originalState, true)
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

describe('composer mapped Jira creation ownership', () => {
  it.each([
    [false, false],
    [true, false],
    [true, true]
  ])(
    'uses the mapped target while preserving Jira linkage (SSH %s, repeated ID %s)',
    (useSsh, repeatedId) => {
      const mappedRepo: Repo = {
        ...currentRepo,
        id: repeatedId ? currentRepo.id : 'mapped',
        path: '/mapped',
        ...(useSsh ? { connectionId: 'builder' } : {})
      }
      const repos = [currentRepo, mappedRepo]
      const projection = projectHostSetupProjectionFromRepos(repos)
      useAppStore.setState({
        settings: null,
        repos,
        endpointProjects: [...projection.projects],
        endpointProjectHostSetups: [...projection.setups],
        projectGroups: [],
        newWorkspaceDraft: null,
        worktreesByRepo: {},
        sparsePresetsByRepo: {},
        workspaceHostScope: 'all',
        sshTargetLabels: new Map([['builder', 'Builder']]),
        detectedAgentIds: [],
        remoteDetectedAgentIds: { builder: [] }
      })
      const { result } = renderHook(() => {
        const target = useComposerTargetState(
          {
            persistDraft: false,
            initialRepoId: mappedRepo.id,
            initialWorkspaceTarget: getRepoWorkspaceCreationTargetHint(
              mappedRepo,
              projection.setups
            ),
            initialTaskSourceContext: jiraSource,
            initialLinkedWorkItem: {
              provider: 'jira',
              type: 'issue',
              number: 0,
              title: 'APP-1 Fix export',
              jiraIdentifier: 'APP-1',
              url: 'https://jira.example.invalid/browse/APP-1'
            }
          },
          decisions
        )
        const external = useComposerExternalSync(target)
        const source = useComposerSourceState(target, external)
        return { ...target, source }
      })

      expect(result.current.initialTargetState.resolvedInitialWorkspaceTarget).toMatchObject({
        status: 'ready',
        target: { hostId: useSsh ? 'ssh:builder' : 'local', repo: mappedRepo }
      })
      expect(result.current.runtimeTargetSelection.selectedRepo).toBe(mappedRepo)
      expect(result.current.runtimeTargetSelection.selectedRepoExecutionHostId).toBe(
        useSsh ? 'ssh:builder' : 'local'
      )
      expect(result.current.sourceContextState.taskSourceContext).toEqual(jiraSource)
      expect(result.current.sourceContextState.linkedWorkItem?.jiraIdentifier).toBe('APP-1')
      if (repeatedId) {
        act(() =>
          result.current.source.targetChangeActions.handleProjectHostSetupChange(
            JSON.stringify([mappedRepo.id, 'local'])
          )
        )
        expect(result.current.runtimeTargetSelection.selectedRepo).toBe(currentRepo)
        act(() =>
          result.current.source.targetChangeActions.handleProjectHostSetupChange(
            JSON.stringify([mappedRepo.id, 'ssh:builder'])
          )
        )
        expect(result.current.runtimeTargetSelection.selectedRepo).toBe(mappedRepo)
        expect(result.current.sourceContextState.taskSourceContext).toEqual(jiraSource)
        expect(result.current.sourceContextState.linkedWorkItem?.jiraIdentifier).toBe('APP-1')
      }
    }
  )
})

function renderUnavailableMappedComposer(
  options: {
    repeatedId?: boolean
    configured?: boolean
    includeSetupHint?: boolean
    emptyRepoOverride?: boolean
    missingSshSetup?: boolean
    missingSshRepo?: boolean
    canonicalSameHostSetup?: boolean
  } = {}
) {
  const mappedRepo: Repo = {
    ...currentRepo,
    id: options.repeatedId ? currentRepo.id : 'mapped',
    path: '/mapped',
    connectionId: 'builder',
    ...(options.canonicalSameHostSetup ? { upstream: { owner: 'fixture', repo: 'app' } } : {})
  }
  const canonicalRepo: Repo = { ...mappedRepo, id: 'canonical', path: '/canonical' }
  const repos = options.canonicalSameHostSetup
    ? [currentRepo, canonicalRepo, mappedRepo]
    : [currentRepo, mappedRepo]
  const projection = projectHostSetupProjectionFromRepos(repos)
  const initialWorkspaceTarget: WorkspaceCreationTargetHint = {
    ...getRepoWorkspaceCreationTargetHint(mappedRepo, projection.setups),
    ...(options.includeSetupHint === false ? { projectHostSetupId: null } : {})
  }
  useAppStore.setState({
    settings: null,
    repos: options.missingSshRepo ? repos.filter((repo) => repo !== mappedRepo) : repos,
    endpointProjects: [...projection.projects],
    endpointProjectHostSetups: projection.setups.filter(
      (setup) => !options.missingSshSetup || setup.hostId !== 'ssh:builder'
    ),
    projectGroups: [],
    newWorkspaceDraft: null,
    worktreesByRepo: {},
    sparsePresetsByRepo: {},
    workspaceHostScope: 'all',
    sshTargetLabels: options.configured ? new Map([['builder', 'Builder']]) : new Map(),
    detectedAgentIds: [],
    remoteDetectedAgentIds: { builder: [] }
  })
  const hook = renderHook(() => {
    const target = useComposerTargetState(
      {
        persistDraft: false,
        initialRepoId: mappedRepo.id,
        initialWorkspaceTarget,
        initialTaskSourceContext: jiraSource,
        initialLinkedWorkItem: {
          provider: 'jira',
          type: 'issue',
          number: 0,
          title: 'APP-1 Fix export',
          jiraIdentifier: 'APP-1',
          url: 'https://jira.example.invalid/browse/APP-1'
        },
        ...(options.emptyRepoOverride ? { repoIdOverride: '' } : {})
      },
      decisions
    )
    const external = useComposerExternalSync(target)
    const source = useComposerSourceState(target, external)
    return { ...target, source }
  })
  return { ...hook, mappedRepo, canonicalRepo }
}

describe('unavailable mapped Jira destinations', () => {
  it.each([true, false])(
    'retains the unavailable SSH mapping (setup hint %s)',
    (includeSetupHint) => {
      const { result } = renderUnavailableMappedComposer({ includeSetupHint })

      expect(result.current.initialTargetState.resolvedInitialWorkspaceTarget.status).toBe(
        'unavailable'
      )
      expect(result.current.runtimeTargetSelection.selectedWorkspaceTarget.status).toBe(
        'unavailable'
      )
      expect(result.current.runtimeTargetSelection.selectedRepo).toBeUndefined()
      expect(result.current.initialTargetState.repoId).toBe('mapped')
    }
  )

  it('does not auto-pick a local repo when an explicit mapping has an empty repo override', () => {
    const { result } = renderUnavailableMappedComposer({ emptyRepoOverride: true })

    expect(result.current.initialTargetState.internalRepoId).toBe('mapped')
    expect(result.current.runtimeTargetSelection.selectedWorkspaceTarget.status).toBe('unavailable')
    expect(result.current.runtimeTargetSelection.selectedRepo).toBeUndefined()
  })

  it('recovers the intended host when it becomes configured', () => {
    const { result, mappedRepo } = renderUnavailableMappedComposer({ missingSshSetup: true })
    act(() => useAppStore.setState({ sshTargetLabels: new Map([['builder', 'Builder']]) }))

    expect(result.current.runtimeTargetSelection.selectedWorkspaceTarget).toMatchObject({
      status: 'ready',
      target: { hostId: 'ssh:builder', repo: mappedRepo }
    })
    expect(result.current.runtimeTargetSelection.selectedRepo).toBe(mappedRepo)
  })

  it('allows the user to replace an unavailable mapped target with a local project', () => {
    const { result } = renderUnavailableMappedComposer()
    act(() => result.current.source.projectTargetActions.handleProjectChange('repo:current'))

    expect(result.current.runtimeTargetSelection.selectedRepo).toBe(currentRepo)
    expect(result.current.runtimeTargetSelection.selectedWorkspaceTarget).toMatchObject({
      status: 'ready',
      target: { hostId: 'local', repo: currentRepo }
    })
  })

  it('withholds a same-ID local repo when the selected SSH setup disappears', () => {
    const { result, mappedRepo } = renderUnavailableMappedComposer({
      repeatedId: true,
      configured: true
    })
    expect(result.current.runtimeTargetSelection.selectedRepo).toBe(mappedRepo)

    act(() =>
      useAppStore.setState((state) => ({
        endpointProjectHostSetups: state.endpointProjectHostSetups.filter(
          (setup) => setup.hostId !== 'ssh:builder'
        ),
        repos: state.repos.filter((repo) => repo !== mappedRepo)
      }))
    )

    expect(result.current.runtimeTargetSelection.selectedWorkspaceTarget.status).toBe('unavailable')
    expect(result.current.runtimeTargetSelection.selectedRepo).toBeUndefined()
    expect(result.current.runtimeTargetSelection.selectedRepoExecutionHostId).toBeNull()
  })

  it('retains a hinted SSH setup missing before initialization despite a same-ID local setup', () => {
    const { result } = renderUnavailableMappedComposer({
      repeatedId: true,
      configured: true,
      missingSshSetup: true,
      missingSshRepo: true
    })

    expect(result.current.runtimeTargetSelection.selectedWorkspaceTarget).toEqual({
      status: 'unavailable',
      reason: 'setup-not-found'
    })
    expect(result.current.runtimeTargetSelection.selectedRepo).toBeUndefined()
    expect(result.current.initialTargetState.repoId).toBe(currentRepo.id)
  })

  it('aligns the repo identity with the canonical same-host setup after recovery', () => {
    const { result, canonicalRepo } = renderUnavailableMappedComposer({
      canonicalSameHostSetup: true
    })
    expect(result.current.runtimeTargetSelection.selectedWorkspaceTarget.status).toBe('unavailable')
    act(() => useAppStore.setState({ sshTargetLabels: new Map([['builder', 'Builder']]) }))

    expect(result.current.runtimeTargetSelection.selectedWorkspaceTarget).toMatchObject({
      status: 'ready',
      target: { repo: canonicalRepo, hostId: 'ssh:builder' }
    })
    expect(result.current.runtimeTargetSelection.selectedRepo).toBe(canonicalRepo)
    expect(result.current.initialTargetState.repoId).toBe(canonicalRepo.id)
    expect(result.current.runtimeTargetSelection.repoIdRef.current).toBe(canonicalRepo.id)
    expect(result.current.sourceContextState.taskSourceContext).toEqual(jiraSource)
    expect(result.current.sourceContextState.linkedWorkItem?.jiraIdentifier).toBe('APP-1')
  })
})
