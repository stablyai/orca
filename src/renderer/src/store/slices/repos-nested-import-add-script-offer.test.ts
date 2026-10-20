import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepositoryAddScriptPreview } from '../../../../shared/repository-add-script-types'
import { createTestStore } from './store-test-helpers'

const mocks = vi.hoisted(() => ({
  resolveRequest: vi.fn(),
  offer: vi.fn(),
  importNested: vi.fn(),
  listGroups: vi.fn(),
  listFolders: vi.fn(),
  listRepos: vi.fn(),
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

function makePreview(
  path: string,
  overrides: Partial<RepositoryAddScriptPreview> = {}
): RepositoryAddScriptPreview {
  return {
    token: `token-${path}`,
    hostId: 'local',
    hostLabel: 'This computer',
    repoId: `repo-${path}`,
    path,
    target: { kind: 'native', cwd: path },
    script: `echo ${path}`,
    scriptHash: `hash-${path}`,
    ...overrides
  }
}

function importResult(
  projects: { path: string; projectId?: string; status: 'imported' | 'already-known' | 'failed' }[]
) {
  return {
    projects,
    importedCount: projects.filter((project) => project.status === 'imported').length,
    alreadyKnownCount: projects.filter((project) => project.status === 'already-known').length,
    failedCount: projects.filter((project) => project.status === 'failed').length
  }
}

const importArgs = {
  parentPath: '/workspace',
  groupName: 'Workspace',
  projectPaths: ['/workspace/app', '/workspace/lib'],
  runtimeEnvironmentId: null,
  mode: 'group' as const
}

describe('nested repository import repository add-script offers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveRequest.mockResolvedValue(undefined)
    mocks.listGroups.mockResolvedValue([])
    mocks.listFolders.mockResolvedValue([])
    mocks.listRepos.mockResolvedValue([])
    vi.stubGlobal('window', {
      api: {
        projectGroups: { importNested: mocks.importNested, list: mocks.listGroups },
        folderWorkspaces: { list: mocks.listFolders },
        repos: { list: mocks.listRepos }
      }
    })
  })

  it('sends the opt-in and offers a preview for an imported path', async () => {
    const preview = makePreview('/workspace/app')
    mocks.resolveRequest.mockResolvedValue({ hostId: 'local' })
    mocks.importNested.mockResolvedValue({
      ...importResult([{ path: '/workspace/app', projectId: preview.repoId, status: 'imported' }]),
      repositoryAddScriptPreviews: [preview]
    })
    const store = createTestStore()

    await store.getState().importNestedRepos(importArgs)

    expect(mocks.importNested).toHaveBeenCalledWith({
      ...importArgs,
      repositoryAddScriptPreview: { hostId: 'local' }
    })
    expect(mocks.offer).toHaveBeenCalledTimes(1)
    expect(mocks.offer).toHaveBeenCalledWith(preview)
  })

  it('omits the opt-in and never offers when the host does not accept one', async () => {
    mocks.importNested.mockResolvedValue(
      importResult([{ path: '/workspace/app', status: 'imported' }])
    )
    const store = createTestStore()

    await store.getState().importNestedRepos(importArgs)

    expect(mocks.importNested).toHaveBeenCalledWith(importArgs)
    expect(mocks.offer).not.toHaveBeenCalled()
  })

  it('does not offer a preview for a repo the import did not insert', async () => {
    mocks.resolveRequest.mockResolvedValue({ hostId: 'local' })
    mocks.importNested.mockResolvedValue({
      ...importResult([
        { path: '/workspace/app', projectId: 'repo-/workspace/app', status: 'already-known' },
        { path: '/workspace/lib', status: 'failed' }
      ]),
      repositoryAddScriptPreviews: [makePreview('/workspace/app'), makePreview('/workspace/lib')]
    })
    const store = createTestStore()

    await store.getState().importNestedRepos(importArgs)

    expect(mocks.offer).not.toHaveBeenCalled()
  })

  it('does not offer a preview addressed to another host', async () => {
    mocks.resolveRequest.mockResolvedValue({ hostId: 'local' })
    mocks.importNested.mockResolvedValue({
      ...importResult([
        { path: '/workspace/app', projectId: 'repo-/workspace/app', status: 'imported' }
      ]),
      repositoryAddScriptPreviews: [makePreview('/workspace/app', { hostId: 'runtime:env-1' })]
    })
    const store = createTestStore()

    await store.getState().importNestedRepos(importArgs)

    expect(mocks.offer).not.toHaveBeenCalled()
  })

  it('offers before a catalog refresh rejects, then reports the refresh failure', async () => {
    const preview = makePreview('/workspace/app')
    mocks.resolveRequest.mockResolvedValue({ hostId: 'local' })
    mocks.importNested.mockResolvedValue({
      ...importResult([{ path: '/workspace/app', projectId: preview.repoId, status: 'imported' }]),
      repositoryAddScriptPreviews: [preview]
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const store = createTestStore()
    store.setState({
      fetchProjectGroups: async () => {
        throw new Error('groups failed')
      }
    })

    await expect(store.getState().importNestedRepos(importArgs)).resolves.toBeNull()

    expect(mocks.offer).toHaveBeenCalledWith(preview)
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Failed to import repositories',
      expect.objectContaining({ description: 'groups failed' })
    )
    errorSpy.mockRestore()
  })

  it('offers by the registered repo id when the scan selected a linked worktree', async () => {
    const preview = makePreview('/workspace/app', { repoId: 'repo-app' })
    mocks.resolveRequest.mockResolvedValue({ hostId: 'local' })
    mocks.importNested.mockResolvedValue({
      // Why: a selected linked worktree registers under its main worktree path.
      ...importResult([{ path: '/workspace/app-wt', projectId: 'repo-app', status: 'imported' }]),
      repositoryAddScriptPreviews: [preview]
    })
    const store = createTestStore()

    await store.getState().importNestedRepos(importArgs)

    expect(mocks.offer).toHaveBeenCalledWith(preview)
  })

  it('does not offer a preview whose repo id the import did not register', async () => {
    mocks.resolveRequest.mockResolvedValue({ hostId: 'local' })
    mocks.importNested.mockResolvedValue({
      ...importResult([{ path: '/workspace/app', projectId: 'repo-app', status: 'imported' }]),
      repositoryAddScriptPreviews: [makePreview('/workspace/app', { repoId: 'repo-other' })]
    })
    const store = createTestStore()

    await store.getState().importNestedRepos(importArgs)

    expect(mocks.offer).not.toHaveBeenCalled()
  })
})
