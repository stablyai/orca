// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type * as NewWorkspace from '@/lib/new-workspace'
import { getDefaultSettings } from '../../../shared/constants'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { AppState } from '@/store/types'

vi.mock('@/lib/new-workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof NewWorkspace>()),
  CLIENT_PLATFORM: 'win32'
}))
import { EMPTY_RETIRED_NAME_REGISTRY } from '../../../shared/worktree/retired-name-registry'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import type { CreateWorktreeResult } from '../../../shared/worktree/create-types'
import type { Repo } from '../../../shared/repo-types'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import { normalizeTaskSourceContext } from '../../../shared/task-source-context'
import { useComposerState } from './useComposerState'
import * as publicComposerDecisions from './useComposerState'
import * as composerDecisions from './composer-state/composer-decisions'

let originalApiDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')
  const preflight = {
    detectAgents: vi.fn<Window['api']['preflight']['detectAgents']>().mockResolvedValue([])
  } satisfies Pick<Window['api']['preflight'], 'detectAgents'>
  const worktrees = {
    listRetiredNames: vi
      .fn<Window['api']['worktrees']['listRetiredNames']>()
      .mockResolvedValue(EMPTY_RETIRED_NAME_REGISTRY)
  } satisfies Pick<Window['api']['worktrees'], 'listRetiredNames'>
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { preflight, worktrees }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

describe('useComposerState integrated lifecycle', () => {
  it('keeps the public composer decisions bound to the canonical decision module', () => {
    expect(publicComposerDecisions.canResolveFolderSmartGitHubSubmit).toBe(
      composerDecisions.canResolveFolderSmartGitHubSubmit
    )
    expect(publicComposerDecisions.getInitialAutoManagedWorkspaceName).toBe(
      composerDecisions.getInitialAutoManagedWorkspaceName
    )
    expect(publicComposerDecisions.getInitialGitHubPrStartPointSelection).toBe(
      composerDecisions.getInitialGitHubPrStartPointSelection
    )
    expect(publicComposerDecisions.getMatchingLinkedTaskSourceContext).toBe(
      composerDecisions.getMatchingLinkedTaskSourceContext
    )
    expect(publicComposerDecisions.isExplicitWorkspaceNameInput).toBe(
      composerDecisions.isExplicitWorkspaceNameInput
    )
    expect(publicComposerDecisions.resolveInitialWorkspaceRunSeed).toBe(
      composerDecisions.resolveInitialWorkspaceRunSeed
    )
    expect(publicComposerDecisions.resolveSmartGitHubCreateNames).toBe(
      composerDecisions.resolveSmartGitHubCreateNames
    )
    expect(publicComposerDecisions.retargetGitHubPrStartPointSelection).toBe(
      composerDecisions.retargetGitHubPrStartPointSelection
    )
  })

  it('passes the selected runtime repository to the name field when IDs repeat across hosts', () => {
    const localRepo: Repo = {
      id: 'same-id',
      path: '/local',
      displayName: 'Local',
      badgeColor: '',
      addedAt: 0,
      defaultJiraProject: { id: '10', key: 'LOC', name: 'Local', siteId: 'site-a' }
    }
    const runtimeRepo: Repo = {
      ...localRepo,
      path: '/remote',
      executionHostId: 'runtime:remote',
      defaultJiraProject: { id: '20', key: 'REM', name: 'Remote', siteId: 'site-b' }
    }
    const projection = projectHostSetupProjectionFromRepos([localRepo, runtimeRepo])
    useAppStore.setState({
      repos: [localRepo, runtimeRepo],
      endpointProjects: [...projection.projects],
      endpointProjectHostSetups: projection.setups.map((setup) => ({
        ...setup,
        id: `${setup.hostId}:setup`
      })),
      projectGroups: [],
      newWorkspaceDraft: null,
      worktreesByRepo: {},
      sparsePresetsByRepo: {},
      runtimeEnvironments: [
        {
          id: 'remote',
          name: 'Remote',
          createdAt: 0,
          updatedAt: 0,
          lastUsedAt: null,
          runtimeId: null,
          endpoints: [],
          preferredEndpointId: 'endpoint'
        }
      ]
    })
    const composer = renderHook(() =>
      useComposerState({
        persistDraft: false,
        initialTaskSourceContext: normalizeTaskSourceContext({
          provider: 'jira',
          projectId: 'repo:same-id',
          hostId: 'runtime:remote'
        })
      })
    )
    expect(composer.result.current.cardProps.selectedRepo).toBe(runtimeRepo)
    expect(composer.result.current.cardProps.smartNameJiraSourceContext?.hostId).toBe(
      'runtime:remote'
    )
    composer.unmount()
  })

  it('creates in concrete B after a normal composer reads old shared endpoint metadata', async () => {
    const original = useAppStore.getState()
    useAppStore.setState(useAppStore.getInitialState(), true)
    const repos: Repo[] = ['a', 'b'].map((id, index) => ({
      id,
      path: `/${id}`,
      displayName: id,
      badgeColor: '',
      addedAt: index + 1,
      upstream: { owner: 'acme', repo: 'app' }
    }))
    const projection = projectHostSetupProjectionFromRepos(repos)
    const projectId = projection.setups[0].projectId
    const endpointProjects = [{ ...projection.projects[0], sourceRepoIds: ['a', 'b'] }]
    const endpointProjectHostSetups = projection.setups.map((setup) => ({ ...setup, projectId }))
    const response = Promise.withResolvers<CreateWorktreeResult>()
    const create = vi.fn<Window['api']['worktrees']['create']>().mockReturnValue(response.promise)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...window.api,
        gh: { repoSlug: vi.fn().mockResolvedValue(null) },
        worktrees: { ...window.api.worktrees, create }
      }
    })
    useAppStore.setState({ repos, endpointProjects, endpointProjectHostSetups })
    const composer = renderHook(() =>
      useComposerState({ initialRepoId: 'b', initialName: 'topic', persistDraft: false })
    )
    try {
      expect(composer.result.current.cardProps.projectOptions.map((project) => project.id)).toEqual(
        expect.arrayContaining([projectId, 'repo:b'])
      )
      expect(composer.result.current.cardProps.selectedProjectId).toBe('repo:b')
      act(() => composer.result.current.cardProps.onProjectChange(projectId))
      act(() => composer.result.current.cardProps.onProjectChange('repo:b'))
      expect(composer.result.current.cardProps.selectedRepoPath).toBe('/b')
      expect(composer.result.current.cardProps.selectedRepoExecutionHostId).toBe('local')
      expect(useAppStore.getState().endpointProjects).toBe(endpointProjects)
      expect(useAppStore.getState().endpointProjectHostSetups).toBe(endpointProjectHostSetups)
      await act(async () => composer.result.current.submitQuick(null))
      await waitFor(() => expect(create).toHaveBeenCalledOnce())
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ repoId: 'b' }))
      const pending = Object.values(useAppStore.getState().pendingWorktreeCreations)[0]
      expect(pending.request.workspaceRunContext).toMatchObject({
        repoId: 'b',
        hostId: 'local',
        path: '/b',
        projectId: 'repo:b'
      })
      act(() => useAppStore.getState().removePendingWorktreeCreation(pending.creationId))
      await act(async () =>
        response.resolve({
          worktree: makeWorktree({ id: 'b::topic', repoId: 'b', path: '/b-topic' })
        })
      )
      await waitFor(() => expect(useAppStore.getState().worktreesByRepo.b[0].id).toBe('b::topic'))
    } finally {
      composer.unmount()
      useAppStore.setState(original, true)
    }
  })

  it.each(['claude', 'codex'] as const)(
    'uses the live Project runtime for the %s quick-create startup request',
    async (agent) => {
      const original = useAppStore.getState()
      useAppStore.setState(useAppStore.getInitialState(), true)
      const repo: Repo = { id: 'b', path: 'C:/app-b', displayName: 'B', badgeColor: '', addedAt: 1 }
      const catalog = projectHostSetupProjectionFromRepos([repo])
      const settings: GlobalSettings = {
        ...getDefaultSettings('/tmp'),
        terminalWindowsShell: 'powershell.exe',
        localWindowsRuntimeDefault: { kind: 'windows-host' as const },
        agentDefaultArgs: { claude: '', codex: '' },
        agentPermissionDefault: 'own',
        agentDefaultEnv: { claude: {}, codex: {} }
      }
      useAppStore.setState({
        repos: [repo],
        endpointProjects: catalog.projects.map((project) => ({
          ...project,
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
        })),
        endpointProjectHostSetups: [...catalog.setups],
        settings,
        sparsePresetsByRepo: { b: [] }
      })
      const responses: ReturnType<typeof Promise.withResolvers<CreateWorktreeResult>>[] = []
      const create = vi.fn<Window['api']['worktrees']['create']>().mockImplementation(() => {
        const response = Promise.withResolvers<CreateWorktreeResult>()
        responses.push(response)
        return response.promise
      })
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          ...window.api,
          gh: { repoSlug: vi.fn().mockResolvedValue(null) },
          worktrees: {
            ...window.api.worktrees,
            create,
            updateMeta: vi.fn().mockResolvedValue(undefined)
          }
        }
      })
      const composer = renderHook(() =>
        useComposerState({
          initialRepoId: 'b',
          initialName: 'topic',
          persistDraft: false,
          initialLinkedWorkItem: {
            provider: 'linear',
            type: 'issue',
            number: 0,
            title: 'Linked task',
            url: 'https://linear.app/acme/issue/ENG-123',
            linearIdentifier: 'ENG-123'
          }
        })
      )
      try {
        act(() => composer.result.current.cardProps.onNoteChange(`fix it's "quoted" $HOME`))
        for (const windows of [false, true]) {
          if (windows) {
            act(() =>
              useAppStore.setState((state): Partial<AppState> => ({
                endpointProjects: state.endpointProjects.map((project) => ({
                  ...project,
                  localWindowsRuntimePreference: { kind: 'windows-host' }
                })),
                endpointProjectHostSetups: state.endpointProjectHostSetups.map((setup) => ({
                  ...setup,
                  updatedAt: setup.updatedAt + 1
                })),
                settings: {
                  ...settings,
                  localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
                }
              }))
            )
          }
          expect(composer.result.current.cardProps.selectedRepo).toBe(repo)
          expect(composer.result.current.cardProps.selectedProjectId).toBe('repo:b')
          expect(composer.result.current.cardProps.selectedRepoExecutionHostId).toBe('local')
          expect(composer.result.current.cardProps.selectedRepoPath).toBe('C:/app-b')
          await act(async () => composer.result.current.submitQuick(agent))
          await waitFor(() => expect(create).toHaveBeenCalledTimes(windows ? 2 : 1))
          const pending = Object.values(useAppStore.getState().pendingWorktreeCreations)[0]
          expect(pending.request.workspaceRunContext).toMatchObject({
            repoId: 'b',
            projectId: 'repo:b',
            projectHostSetupId: catalog.setups[0].id,
            hostId: 'local',
            path: 'C:/app-b'
          })
          const draft = `fix it's "quoted" $HOME\n\nLinked Linear issue: ENG-123\nhttps://linear.app/acme/issue/ENG-123\n`
          if (agent === 'claude') {
            const quoted = windows
              ? '"fix it\'s `"quoted`" `$HOME`n`nLinked Linear issue: ENG-123`nhttps://linear.app/acme/issue/ENG-123"'
              : `'${draft.trim().replaceAll("'", "'\"'\"'")}'`
            expect(pending.request.startup?.command).toBe(`claude --prefill ${quoted}`)
            expect(pending.request.startupPlan?.draftPrompt).toBeUndefined()
          } else {
            expect(pending.request.startup).toBeUndefined()
            expect(pending.request.startupPlan?.launchCommand).toBe('codex')
            expect(pending.request.startupPlan?.draftPrompt).toBe(draft)
          }
          act(() => useAppStore.getState().removePendingWorktreeCreation(pending.creationId))
          await act(async () =>
            responses[windows ? 1 : 0].resolve({
              worktree: makeWorktree({
                id: `b::topic-${windows}`,
                repoId: 'b',
                path: 'C:/app-b-topic'
              })
            })
          )
        }
      } finally {
        composer.unmount()
        await act(async () => {
          for (const response of responses) {
            response.resolve({
              worktree: makeWorktree({ id: 'b::cleanup', repoId: 'b', path: 'C:/app-b-topic' })
            })
          }
        })
        useAppStore.setState(original, true)
      }
    }
  )

  it('composes two live composers and exposes the parent-worktree control state', () => {
    useAppStore.setState({
      repos: [],
      endpointProjects: [],
      projectGroups: [],
      endpointProjectHostSetups: [],
      newWorkspaceDraft: null,
      worktreesByRepo: {},
      sparsePresetsByRepo: {}
    })
    const first = renderHook(() => useComposerState({ initialName: 'first', persistDraft: false }))
    const second = renderHook(() =>
      useComposerState({ initialName: 'second', persistDraft: false })
    )

    expect(first.result.current.cardProps.name).toBe('first')
    expect(second.result.current.cardProps.name).toBe('second')
    expect(first.result.current.cardProps.parentWorktreeId).toBeNull()
    expect(first.result.current.cardProps.onParentWorktreeIdChange).toBeTypeOf('function')
    act(() => first.result.current.cardProps.onParentWorktreeIdChange('repo-1::/parent'))
    expect(first.result.current.cardProps.parentWorktreeId).toBe('repo-1::/parent')
    expect(first.result.current.cardProps.onNativeFileDrop).toBeUndefined()
    expect(second.result.current.cardProps.onNativeFileDrop).toBeUndefined()

    second.unmount()
    first.unmount()
  })
})
