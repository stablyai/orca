// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/repo-types'
import { EMPTY_RETIRED_NAME_REGISTRY } from '../../../../shared/worktree/retired-name-registry'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { getRepoWorkspaceCreationTargetHint } from '@/lib/project-host-workspace-target'
import * as decisions from './composer-decisions'
import { useComposerTargetState } from './composer-target-state'
import { useComposerExternalSync } from './composer-external-sync'
import { useComposerSourceState } from './composer-source-state'

const originalState = useAppStore.getState()
let originalApi: PropertyDescriptor | undefined
const remote = {
  canonicalKey: 'github.com/stablyai/orca',
  remoteName: 'origin',
  remoteUrl: 'git@github.com:stablyai/orca.git'
}
const mainClone: Repo = {
  id: 'main-clone',
  path: '/code/orca',
  displayName: 'orca',
  badgeColor: '',
  addedAt: 0,
  gitRemoteIdentity: remote
}
const reviewClone: Repo = {
  ...mainClone,
  id: 'review-clone',
  path: '/code/orca-review',
  displayName: 'orca-review',
  addedAt: 1
}

beforeEach(() => {
  originalApi = Object.getOwnPropertyDescriptor(window, 'api')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      preflight: {
        detectAgents: vi.fn<Window['api']['preflight']['detectAgents']>().mockResolvedValue([])
      },
      gh: {
        repoSlug: vi.fn<Window['api']['gh']['repoSlug']>().mockResolvedValue(null)
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

function renderComposerFor(repo: Repo) {
  const repos = [mainClone, reviewClone]
  const projection = projectHostSetupProjectionFromRepos(repos)
  useAppStore.setState({
    settings: null,
    repos,
    projects: [...projection.projects],
    projectHostSetups: [...projection.setups],
    projectGroups: [],
    newWorkspaceDraft: null,
    worktreesByRepo: {},
    sparsePresetsByRepo: {},
    workspaceHostScope: 'all',
    detectedAgentIds: []
  })
  return renderHook(() => {
    const target = useComposerTargetState(
      {
        persistDraft: false,
        initialRepoId: repo.id,
        initialWorkspaceTarget: getRepoWorkspaceCreationTargetHint(repo, projection.setups)
      },
      decisions
    )
    const external = useComposerExternalSync(target)
    const source = useComposerSourceState(target, external)
    return { ...target, source }
  })
}

function checkoutOptionId(
  options: ReturnType<
    typeof renderComposerFor
  >['result']['current']['runtimeTargetSelection']['projectOptions'],
  repoId: string
): string {
  const option = options.find(
    (entry) => entry.kind === 'project' && entry.checkout?.repoId === repoId
  )
  if (!option) {
    throw new Error(`Expected a picker row for ${repoId}`)
  }
  return option.id
}

describe('same-host checkouts of one remote', () => {
  it('opens on the checkout it was started from and lists both checkouts', () => {
    const { result } = renderComposerFor(reviewClone)
    const selection = result.current.runtimeTargetSelection

    expect(selection.selectedRepo).toBe(reviewClone)
    expect(selection.projectOptions.map((option) => option.displayName)).toEqual([
      'orca',
      'orca-review'
    ])
    expect(selection.projectHostSetupOptions).toMatchObject([
      { kind: 'ready', repoId: reviewClone.id, path: reviewClone.path }
    ])
  })

  it('switches between the checkouts from the project picker', () => {
    const { result } = renderComposerFor(mainClone)

    act(() =>
      result.current.source.projectTargetActions.handleProjectChange(
        checkoutOptionId(result.current.runtimeTargetSelection.projectOptions, reviewClone.id)
      )
    )
    expect(result.current.runtimeTargetSelection.selectedRepo).toBe(reviewClone)
    expect(result.current.runtimeTargetSelection.projectHostSetupOptions).toMatchObject([
      { kind: 'ready', repoId: reviewClone.id }
    ])

    act(() =>
      result.current.source.projectTargetActions.handleProjectChange(
        checkoutOptionId(result.current.runtimeTargetSelection.projectOptions, mainClone.id)
      )
    )
    expect(result.current.runtimeTargetSelection.selectedRepo).toBe(mainClone)
  })
})
