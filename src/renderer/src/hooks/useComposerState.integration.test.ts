// @vitest-environment happy-dom

import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createElement } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NewWorkspaceComposerNameSection } from '@/components/new-workspace/NewWorkspaceComposerNameSection'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { EMPTY_RETIRED_NAME_REGISTRY } from '../../../shared/worktree/retired-name-registry'
import type { CreateWorktreeResult } from '../../../shared/worktree/create-types'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import type { Repo } from '../../../shared/repo-types'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import { normalizeTaskSourceContext } from '../../../shared/task-source-context'
import { useComposerState } from './useComposerState'
import * as publicComposerDecisions from './useComposerState'
import * as composerDecisions from './composer-state/composer-decisions'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'

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
      projects: [...projection.projects],
      projectHostSetups: projection.setups.map((setup) => ({
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

  it('preserves new-branch intent through name edits and submission in the real composer', async () => {
    const original = useAppStore.getState()
    const response = Promise.withResolvers<CreateWorktreeResult>()
    const create = vi.fn<Window['api']['worktrees']['create']>().mockReturnValue(response.promise)
    const gh = {
      repoSlug: vi.fn<Window['api']['gh']['repoSlug']>().mockResolvedValue(null),
      listWorkItems: vi.fn<Window['api']['gh']['listWorkItems']>().mockResolvedValue({
        items: [],
        sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
      })
    } satisfies Pick<Window['api']['gh'], 'repoSlug' | 'listWorkItems'>
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ...window.api, gh, worktrees: { ...window.api.worktrees, create } }
    })
    useAppStore.setState(useAppStore.getInitialState(), true)
    const repo: Repo = {
      id: 'branch-repo',
      path: '/branch-repo',
      displayName: 'Branch repo',
      badgeColor: '',
      addedAt: 0
    }
    const projection = projectHostSetupProjectionFromRepos([repo])
    useAppStore.setState({
      repos: [repo],
      projects: [...projection.projects],
      projectHostSetups: [...projection.setups],
      sparsePresetsByRepo: { [repo.id]: [] }
    })
    const holder: { composer?: ReturnType<typeof useComposerState> } = {}
    function BranchEditor() {
      const composer = useComposerState({ initialRepoId: repo.id, persistDraft: false })
      holder.composer = composer
      return createElement(NewWorkspaceComposerNameSection, {
        ...composer.cardProps,
        nameInputRef: composer.nameInputRef,
        onNamePlainEnter: () => {}
      })
    }
    const user = userEvent.setup()
    let view: ReturnType<typeof render> | undefined
    setLocalRuntimeCapabilitiesForTests(['worktree.open-existing-branch.v2'])
    try {
      view = render(createElement(TooltipProvider, null, createElement(BranchEditor)))
      act(() => holder.composer?.cardProps.onSmartBranchSelect('feature/source', 'feature/source'))
      await user.click(screen.getByRole('radio', { name: 'New branch' }))
      const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'New branch name' })
      await user.type(input, 'feature/my-review')
      expect(screen.getByRole('textbox', { name: 'New branch name' })).toBe(input)
      expect(input.value).toBe('feature/my-review')
      expect(document.activeElement).toBe(input)
      expect(holder.composer?.cardProps.baseBranch).toBe('feature/source')
      await user.clear(input)
      await user.type(input, 'feature/source')
      expect(input.value).toBe('feature/source')
      await act(async () => holder.composer?.submitQuick(null))
      await waitFor(() => expect(create).toHaveBeenCalledOnce())
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          branchIntent: 'create-new',
          baseBranch: 'feature/source',
          branchNameOverride: 'feature/source'
        })
      )
      await act(async () =>
        response.resolve({
          worktree: makeWorktree({
            id: 'branch-repo::feature-source',
            repoId: repo.id,
            path: '/branch-repo-source'
          })
        })
      )
      await waitFor(() =>
        expect(useAppStore.getState().worktreesByRepo[repo.id]?.[0].id).toBe(
          'branch-repo::feature-source'
        )
      )
      await user.click(screen.getByRole('radio', { name: 'Existing branch' }))
      expect(screen.queryByRole('textbox', { name: 'New branch name' })).toBeNull()
    } finally {
      view?.unmount()
      setLocalRuntimeCapabilitiesForTests(null)
      useAppStore.setState(original, true)
    }
  })

  it('composes two live composers and exposes the parent-worktree control state', () => {
    useAppStore.setState({
      repos: [],
      projects: [],
      projectGroups: [],
      projectHostSetups: [],
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
