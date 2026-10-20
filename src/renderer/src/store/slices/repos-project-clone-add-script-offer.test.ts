import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Project,
  ProjectHostSetup,
  ProjectHostSetupExistingFolderArgs,
  ProjectHostSetupResult
} from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { RepositoryAddScriptPreview } from '../../../../shared/repository-add-script-types'
import { createTestStore } from './store-test-helpers'

const mocks = vi.hoisted(() => ({
  resolveRequest: vi.fn(),
  offer: vi.fn(),
  reposClone: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/runtime/runtime-repository-add-script', () => ({
  resolveRuntimeRepositoryAddScriptRequest: mocks.resolveRequest
}))

vi.mock('@/store/repository-add-script-prompt', () => ({
  offerRepositoryAddScript: mocks.offer
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn()
  }
}))

const project: Project = {
  id: 'project-1',
  displayName: 'Project',
  badgeColor: '#000',
  sourceRepoIds: ['repo-cloned'],
  createdAt: 1,
  updatedAt: 1
}

const clonedRepo: Repo = {
  id: 'repo-cloned',
  path: '/srv/project',
  displayName: 'Project',
  badgeColor: '#000',
  addedAt: 1,
  kind: 'git'
}

const setup: ProjectHostSetup = {
  id: clonedRepo.id,
  projectId: project.id,
  hostId: 'local',
  repoId: clonedRepo.id,
  path: clonedRepo.path,
  displayName: clonedRepo.displayName,
  setupState: 'ready',
  setupMethod: 'cloned',
  createdAt: 1,
  updatedAt: 1
}

function makePreview(
  overrides: Partial<RepositoryAddScriptPreview> = {}
): RepositoryAddScriptPreview {
  return {
    token: 'token-cloned',
    hostId: 'local',
    hostLabel: 'This computer',
    repoId: clonedRepo.id,
    path: clonedRepo.path,
    target: { kind: 'native', cwd: clonedRepo.path },
    script: 'echo cloned',
    scriptHash: 'hash-cloned',
    ...overrides
  }
}

const cloneArgs = {
  projectId: project.id,
  hostId: 'local' as const,
  url: 'https://github.com/stablyai/orca.git',
  destination: '/srv',
  displayName: 'Project'
}

function setupResult(): ProjectHostSetupResult {
  return { project, setup, repo: { ...clonedRepo, executionHostId: 'local' } }
}

function setupExistingFolderMock(result: ProjectHostSetupResult | null) {
  return vi.fn(async (_args: ProjectHostSetupExistingFolderArgs) => result)
}

describe('setupProjectClone repository add-script offer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveRequest.mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { repos: { clone: mocks.reposClone } } })
  })

  it('opts the clone in, keeps setup opted out, and offers after a successful setup', async () => {
    const preview = makePreview()
    mocks.resolveRequest.mockResolvedValue({ hostId: 'local' })
    mocks.reposClone.mockResolvedValue({
      repo: clonedRepo,
      repositoryAddScriptPreview: preview
    })
    const setupExistingFolder = setupExistingFolderMock(setupResult())
    const store = createTestStore()
    store.setState({ setupProjectExistingFolder: setupExistingFolder })

    await store.getState().setupProjectClone(cloneArgs)

    expect(mocks.reposClone).toHaveBeenCalledWith({
      url: cloneArgs.url,
      destination: cloneArgs.destination,
      repositoryAddScriptPreview: { hostId: 'local' }
    })
    expect(setupExistingFolder).toHaveBeenCalledWith(
      {
        projectId: project.id,
        hostId: 'local',
        path: clonedRepo.path,
        kind: 'git',
        displayName: 'Project',
        setupMethod: 'cloned'
      },
      { offerAddScript: false }
    )
    expect(setupExistingFolder.mock.calls[0][0]).not.toHaveProperty('repositoryAddScriptPreview')
    expect(mocks.offer).toHaveBeenCalledTimes(1)
    expect(mocks.offer).toHaveBeenCalledWith(preview)
  })

  it('does not offer when the setup leg returns nothing', async () => {
    mocks.resolveRequest.mockResolvedValue({ hostId: 'local' })
    mocks.reposClone.mockResolvedValue({
      repo: clonedRepo,
      repositoryAddScriptPreview: makePreview()
    })
    const setupExistingFolder = setupExistingFolderMock(null)
    const store = createTestStore()
    store.setState({ setupProjectExistingFolder: setupExistingFolder })

    await expect(store.getState().setupProjectClone(cloneArgs)).resolves.toBeNull()

    expect(mocks.offer).not.toHaveBeenCalled()
    // Why: pin the null guard; without it the preview deref throws into the clone-failure toast.
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('does not offer a preview addressed to another repo when the host opts in', async () => {
    mocks.resolveRequest.mockResolvedValue({ hostId: 'local' })
    mocks.reposClone.mockResolvedValue({
      repo: clonedRepo,
      repositoryAddScriptPreview: makePreview({ repoId: 'repo-other' })
    })
    const setupExistingFolder = setupExistingFolderMock(setupResult())
    const store = createTestStore()
    store.setState({ setupProjectExistingFolder: setupExistingFolder })

    await store.getState().setupProjectClone(cloneArgs)

    expect(mocks.offer).not.toHaveBeenCalled()
  })
})
