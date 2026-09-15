// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'

vi.mock('@/hooks/useDetectedAgents', () => ({ useDetectedAgents: () => ({ detectedIds: null }) }))
vi.mock('@/components/sidebar/folder-workspace-composer-path-status', () => ({
  useFolderWorkspaceComposerPathStatus: () => ({
    pathStatusBlocksCreate: false,
    pathStatusProjectError: null
  })
}))
vi.mock('@/hooks/useEphemeralVmRecipeOptions', () => ({
  useEphemeralVmRecipeOptions: () => ({
    recipes: [],
    selectedRecipeId: null,
    setSelectedRecipeId: vi.fn(),
    error: null
  })
}))

import { useComposerRuntimeTargetSelection } from './runtime-target-selection'

const PROJECT_ID = 'github:stablyai/orca'

function makeRepo(id: string, path: string): Repo {
  return { id, path, displayName: id, badgeColor: '#000000', addedAt: 1 }
}

function makeSetup(id: string, repoId: string, path: string): ProjectHostSetup {
  return {
    id,
    projectId: PROJECT_ID,
    hostId: 'local' as ExecutionHostId,
    repoId,
    path,
    displayName: repoId,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1
  }
}

const projects: Project[] = [
  {
    id: PROJECT_ID,
    displayName: 'orca',
    badgeColor: '#000000',
    sourceRepoIds: ['orca-main', 'orca-side'],
    createdAt: 1,
    updatedAt: 1
  }
]

const eligibleRepos = [
  makeRepo('orca-main', '/checkouts/main'),
  makeRepo('orca-side', '/checkouts/side')
]

const projectHostSetups = [
  makeSetup('setup-main', 'orca-main', '/checkouts/main'),
  makeSetup('setup-side', 'orca-side', '/checkouts/side')
]

function renderSelection(overrides: Record<string, unknown>) {
  return renderHook(() =>
    useComposerRuntimeTargetSelection({
      actionableHostIds: new Set<ExecutionHostId>(['local']),
      activeRepoId: null,
      eligibleRepos,
      hostOptions: [{ id: 'local', kind: 'local', label: 'Local Mac', health: 'local' }],
      initialEphemeralVmRecipeId: null,
      projectGroups: [],
      projectHostSetups,
      projects,
      repoId: '',
      repos: eligibleRepos,
      selectedProjectGroup: null,
      selectedProjectHostSetupOverrideId: null,
      selectedProjectIdOverride: null,
      settings: null,
      sshConnectionStates: new Map(),
      workspaceHostScope: 'all',
      worktreesByRepo: new Map(),
      ...overrides
    } as unknown as Parameters<typeof useComposerRuntimeTargetSelection>[0])
  )
}

describe('composer run-target selection with several ready setups (STA-6080)', () => {
  it('keeps the project on screen and offers every checkout while the choice is open', () => {
    const { result } = renderSelection({ selectedProjectIdOverride: PROJECT_ID })

    expect(result.current.selectedWorkspaceTarget.status).toBe('ambiguous')
    expect(result.current.runTargetChoiceCandidates).toHaveLength(2)
    expect(result.current.selectedRepoProjectId).toBe(PROJECT_ID)
    expect(result.current.selectedProjectHostSetupId).toBeNull()
    expect(result.current.selectedRepo).toBeUndefined()
    expect(
      result.current.projectHostSetupOptions
        .filter((option) => option.kind === 'ready')
        .map((option) => option.id)
    ).toEqual(['setup-main', 'setup-side'])
  })

  it('resolves the chosen setup once the user picks one', () => {
    const { result } = renderSelection({
      selectedProjectIdOverride: PROJECT_ID,
      selectedProjectHostSetupOverrideId: 'setup-side',
      repoId: 'orca-side'
    })

    expect(result.current.selectedWorkspaceTarget.status).toBe('ready')
    expect(result.current.runTargetChoiceCandidates).toBeNull()
    expect(result.current.selectedProjectHostSetupId).toBe('setup-side')
    expect(result.current.selectedRepo?.path).toBe('/checkouts/side')
  })
})
