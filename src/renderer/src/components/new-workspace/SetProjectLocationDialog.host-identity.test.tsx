// @vitest-environment happy-dom

import { cleanup, render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostRegistryEntry } from '../../../../shared/execution-host-registry'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import {
  buildProjectHostSetupOptions,
  type NeedsSetupProjectHostOption
} from '@/lib/project-host-setup-options'
import { useTargetChangeActions } from '@/hooks/composer-state/target-change-actions'
import * as decisions from '@/hooks/composer-state/composer-decisions'
import { SetProjectLocationDialog } from './SetProjectLocationDialog'

const storeMock = vi.hoisted(() => {
  const repos: Repo[] = []
  const projectHostSetups: ProjectHostSetup[] = []
  return {
    repos,
    projectHostSetups,
    setupProjectExistingFolder: vi.fn(),
    setupProjectClone: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeMock) => unknown) => selector(storeMock),
    { getState: () => storeMock }
  )
}))

vi.mock('@/components/sidebar/CreateProjectLocationField', () => ({
  CreateProjectParentBrowser: () => null
}))

const localRepo: Repo = {
  id: 'same-id',
  path: '/local',
  displayName: 'Orca',
  badgeColor: '',
  addedAt: 0,
  upstream: { owner: 'stablyai', repo: 'orca' }
}
const runtimeRepo: Repo = {
  ...localRepo,
  path: '/runtime',
  executionHostId: 'runtime:builder'
}
const hosts: ExecutionHostRegistryEntry[] = [
  { id: 'local', kind: 'local', label: 'Local', detail: '', health: 'local' },
  {
    id: 'runtime:builder',
    kind: 'runtime',
    label: 'Builder',
    detail: '',
    health: 'available'
  }
]
const localProjection = projectHostSetupProjectionFromRepos([localRepo])
const runtimeProjection = projectHostSetupProjectionFromRepos([runtimeRepo])
const option: NeedsSetupProjectHostOption = {
  id: 'needs-setup:runtime:builder',
  kind: 'needs-setup',
  projectId: localProjection.projects[0].id,
  hostId: 'runtime:builder',
  label: 'Builder',
  detail: 'Project location not set',
  isAvailable: true,
  attention: false,
  canSetLocation: true
}

function createInput(): Parameters<typeof useTargetChangeActions>[0] {
  return {
    baseBranch: undefined,
    branchAutoNameRef: { current: '' },
    decisions,
    folderSourceRepos: [],
    hostOptions: hosts,
    linkedWorkItem: {
      type: 'issue',
      provider: 'jira',
      number: 0,
      title: 'APP-1 Fix export',
      jiraIdentifier: 'APP-1',
      url: 'https://jira.example.invalid/browse/APP-1'
    },
    projectHostSetupOptions: buildProjectHostSetupOptions({
      projectId: option.projectId,
      projectHostSetups: localProjection.setups,
      eligibleRepos: [localRepo],
      hosts: [hosts[0]]
    }),
    repoId: localRepo.id,
    selectedRepoProjectId: option.projectId,
    setBaseBranch: vi.fn(),
    setBranchNameOverride: vi.fn(),
    setBranchNameOverridePreservesNameEdits: vi.fn(),
    setCompareBaseRef: vi.fn(),
    setForkPushWarning: vi.fn(),
    setLinkedGitLabIssue: vi.fn(),
    setLinkedGitLabMR: vi.fn(),
    setLinkedIssue: vi.fn(),
    setLinkedPR: vi.fn(),
    setLinkedTaskSourceContext: vi.fn(),
    setLinkedWorkItem: vi.fn(),
    setProjectError: vi.fn(),
    setPushTarget: vi.fn(),
    setRepoId: vi.fn(),
    setReuseEligibleBranch: vi.fn(),
    setReuseSelectedBranch: vi.fn(),
    setSelectedProjectHostSetupOverrideId: vi.fn(),
    setSelectedProjectHostSetupOverrideHostId: vi.fn(),
    setSparseDirectories: vi.fn(),
    setSparseEnabled: vi.fn(),
    setSparseSelectedPresetId: vi.fn(),
    setStartFromResetHint: vi.fn(),
    smartSourceSelectionRef: { current: null }
  }
}

beforeEach(() => {
  storeMock.repos = [localRepo]
  storeMock.projectHostSetups = [...localProjection.setups]
  storeMock.setupProjectExistingFolder.mockReset()
  storeMock.setupProjectClone.mockReset()
  const publishRuntimeSetup = async () => {
    storeMock.repos = [localRepo, runtimeRepo]
    storeMock.projectHostSetups = [...localProjection.setups, ...runtimeProjection.setups]
    return {
      project: runtimeProjection.projects[0],
      repo: runtimeRepo,
      setup: runtimeProjection.setups[0]
    }
  }
  storeMock.setupProjectExistingFolder.mockImplementation(publishRuntimeSetup)
  storeMock.setupProjectClone.mockImplementation(publishRuntimeSetup)
})

afterEach(cleanup)

describe('set-location host identity', () => {
  it.each(['existing folder', 'clone'])(
    'selects the newly published runtime setup after %s when a stale local option has the same ID',
    async (method) => {
      const input = createInput()
      const { result } = renderHook(() => useTargetChangeActions(input))
      render(
        <SetProjectLocationDialog
          option={option}
          projectName="Orca"
          projectKind="git"
          defaultCloneUrl="https://github.com/stablyai/orca.git"
          onClose={vi.fn()}
          onReady={(selection) => result.current.handleProjectHostSetupChange(selection)}
        />
      )
      const user = userEvent.setup()
      if (method === 'clone') {
        await user.click(screen.getByRole('button', { name: /Clone from URL/ }))
        await user.type(screen.getByPlaceholderText('/destination/on/host'), '/runtime')
        await user.click(screen.getByRole('button', { name: 'Clone' }))
      } else {
        await user.click(screen.getByRole('button', { name: /Browse folder/ }))
        await user.type(screen.getByPlaceholderText('/path/to/project/on/host'), '/runtime')
        await user.click(screen.getByRole('button', { name: 'Set location' }))
      }

      expect(input.setSelectedProjectHostSetupOverrideHostId).toHaveBeenCalledWith(
        'runtime:builder'
      )
      expect(input.setSelectedProjectHostSetupOverrideHostId).not.toHaveBeenCalledWith('local')
      expect(input.setSelectedProjectHostSetupOverrideId).toHaveBeenCalledWith('same-id')
      expect(input.setLinkedTaskSourceContext).not.toHaveBeenCalled()
      expect(input.setLinkedWorkItem).not.toHaveBeenCalled()
    }
  )
})
