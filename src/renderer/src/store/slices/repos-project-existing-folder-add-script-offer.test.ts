import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import type {
  Project,
  ProjectHostSetup,
  ProjectHostSetupResult
} from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { RepositoryAddScriptPreview } from '../../../../shared/repository-add-script-types'
import { createTestStore } from './store-test-helpers'

const mocks = vi.hoisted(() => ({
  resolveRequest: vi.fn(),
  offer: vi.fn(),
  setupExistingFolder: vi.fn(),
  toastError: vi.fn(),
  callRuntimeRpc: vi.fn(),
  assertCapability: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeRpcClient>()
  return {
    ...actual,
    callRuntimeRpc: mocks.callRuntimeRpc,
    assertRuntimeEnvironmentCapability: mocks.assertCapability
  }
})

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
  sourceRepoIds: ['repo-folder'],
  createdAt: 1,
  updatedAt: 1
}

const folderRepo: Repo = {
  id: 'repo-folder',
  path: '/work/existing',
  displayName: 'Existing',
  badgeColor: '#000',
  addedAt: 1,
  kind: 'git'
}

const setup: ProjectHostSetup = {
  id: folderRepo.id,
  projectId: project.id,
  hostId: 'local',
  repoId: folderRepo.id,
  path: folderRepo.path,
  displayName: folderRepo.displayName,
  setupState: 'ready',
  setupMethod: 'imported-existing-folder',
  createdAt: 1,
  updatedAt: 1
}

function makePreview(
  overrides: Partial<RepositoryAddScriptPreview> = {}
): RepositoryAddScriptPreview {
  return {
    token: 'token-folder',
    hostId: 'local',
    hostLabel: 'This computer',
    repoId: folderRepo.id,
    path: folderRepo.path,
    target: { kind: 'native', cwd: folderRepo.path },
    script: 'echo folder',
    scriptHash: 'hash-folder',
    ...overrides
  }
}

function setupResult(preview?: RepositoryAddScriptPreview): ProjectHostSetupResult {
  return {
    project,
    setup,
    repo: { ...folderRepo, executionHostId: 'local' },
    ...(preview ? { repositoryAddScriptPreview: preview } : {})
  }
}

const addFolderArgs = {
  projectId: project.id,
  hostId: 'local' as const,
  path: folderRepo.path,
  kind: 'git' as const,
  setupMethod: 'imported-existing-folder' as const
}

describe('setupProjectExistingFolder repository add-script offer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveRequest.mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      api: { projects: { setupExistingFolder: mocks.setupExistingFolder } }
    })
  })

  it('opts in and offers the preview the registration returned', async () => {
    const preview = makePreview()
    mocks.resolveRequest.mockResolvedValue({ hostId: 'local' })
    mocks.setupExistingFolder.mockResolvedValue(setupResult(preview))
    const store = createTestStore()

    await store.getState().setupProjectExistingFolder(addFolderArgs)

    expect(mocks.setupExistingFolder).toHaveBeenCalledWith({
      ...addFolderArgs,
      repositoryAddScriptPreview: { hostId: 'local' }
    })
    expect(mocks.offer).toHaveBeenCalledTimes(1)
    expect(mocks.offer).toHaveBeenCalledWith(preview)
  })

  it('opts a paired host in and offers the preview returned over runtime RPC', async () => {
    const preview = makePreview({ hostId: 'runtime:env-1' })
    mocks.resolveRequest.mockResolvedValue({ hostId: 'runtime:env-1' })
    mocks.callRuntimeRpc.mockResolvedValue({ result: setupResult(preview) })
    const store = createTestStore()
    const args = { ...addFolderArgs, hostId: 'runtime:env-1' as const }

    await store.getState().setupProjectExistingFolder(args)

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'projectHostSetup.setupExistingFolder',
      { ...args, repositoryAddScriptPreview: { hostId: 'runtime:env-1' } },
      { timeoutMs: 15_000 }
    )
    expect(mocks.offer).toHaveBeenCalledWith(preview)
  })

  it('omits the opt-in and never offers when the host does not accept one', async () => {
    mocks.setupExistingFolder.mockResolvedValue(setupResult())
    const store = createTestStore()

    await store.getState().setupProjectExistingFolder(addFolderArgs)

    expect(mocks.setupExistingFolder).toHaveBeenCalledWith(addFolderArgs)
    expect(mocks.setupExistingFolder.mock.calls[0][0]).not.toHaveProperty(
      'repositoryAddScriptPreview'
    )
    expect(mocks.offer).not.toHaveBeenCalled()
  })

  it('never opts a folder registration in', async () => {
    mocks.resolveRequest.mockResolvedValue({ hostId: 'local' })
    mocks.setupExistingFolder.mockResolvedValue(setupResult())
    const store = createTestStore()
    const args = { ...addFolderArgs, kind: 'folder' as const }

    await store.getState().setupProjectExistingFolder(args)

    expect(mocks.resolveRequest).not.toHaveBeenCalled()
    expect(mocks.setupExistingFolder.mock.calls[0][0]).not.toHaveProperty(
      'repositoryAddScriptPreview'
    )
    expect(mocks.offer).not.toHaveBeenCalled()
  })

  it('does not offer a preview addressed to another repo', async () => {
    mocks.resolveRequest.mockResolvedValue({ hostId: 'local' })
    mocks.setupExistingFolder.mockResolvedValue(setupResult(makePreview({ repoId: 'repo-other' })))
    const store = createTestStore()

    await store.getState().setupProjectExistingFolder(addFolderArgs)

    expect(mocks.offer).not.toHaveBeenCalled()
  })

  it('skips the opt-in and the offer when the caller owns the offer', async () => {
    mocks.resolveRequest.mockResolvedValue({ hostId: 'local' })
    mocks.setupExistingFolder.mockResolvedValue(setupResult(makePreview()))
    const store = createTestStore()

    await store.getState().setupProjectExistingFolder(addFolderArgs, { offerAddScript: false })

    expect(mocks.setupExistingFolder).toHaveBeenCalledWith(addFolderArgs)
    expect(mocks.resolveRequest).not.toHaveBeenCalled()
    expect(mocks.offer).not.toHaveBeenCalled()
  })
})
