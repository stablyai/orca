import { createStore, type StoreApi } from 'zustand/vanilla'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEditorSlice } from './editor'
import { createCheckRunDetailsRequestId } from '@/components/editor/check-run-details-tab'
import type { AppState } from '../types'
import type { PRCheckRunDetails } from '../../../../shared/github/check-types'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

const check = {
  name: 'verify',
  status: 'completed' as const,
  conclusion: 'failure' as const,
  url: null,
  checkRunId: 42
}
const details: PRCheckRunDetails = {
  name: 'verify',
  status: 'completed',
  conclusion: 'success',
  url: null,
  detailsUrl: null,
  startedAt: null,
  completedAt: null,
  title: 'Build passed',
  summary: null,
  text: null,
  annotations: [],
  jobs: []
}
const pairedRepo = {
  id: 'repo-1',
  path: '/remote',
  executionHostId: 'runtime:server',
  connectionId: 'builder'
}
const pairedWorktree = {
  id: 'wt-1',
  repoId: 'repo-1',
  path: '/remote',
  hostId: 'ssh:builder',
  runtimeOwnerEnvironmentId: 'server'
}

function createOwnerStore(state: Record<string, unknown>) {
  const fetchPRCheckDetails = vi.fn().mockResolvedValue(details)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = createStore<any>()((...args: any[]) => ({
    activeWorktreeId: 'wt-1',
    detectedWorktreesByRepo: {},
    settings: { activeRuntimeEnvironmentId: null },
    fetchPRCheckDetails,
    ...state,
    ...createEditorSlice(...(args as Parameters<typeof createEditorSlice>))
  })) as unknown as StoreApi<AppState>
  // Catalog fixtures carry only the owner fields these lookups read.
  const setCatalog = (catalog: Record<string, unknown>) =>
    (store as unknown as StoreApi<Record<string, unknown>>).setState(catalog)
  return { store, fetchPRCheckDetails, setCatalog }
}

function open(store: StoreApi<AppState>): string {
  store.getState().openCheckRunDetails('wt-1', 'repo:99', check, {
    details: null,
    loading: false,
    error: null
  })
  return store.getState().activeFileId!
}

describe('check-details tab owner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    {
      rival: 'a direct SSH listing',
      repo: { id: 'repo-1', path: '/direct', connectionId: 'builder' },
      worktree: { ...pairedWorktree, path: '/direct', runtimeOwnerEnvironmentId: undefined }
    },
    {
      rival: 'another server',
      repo: { ...pairedRepo, path: '/other', executionHostId: 'runtime:other' },
      worktree: { ...pairedWorktree, path: '/other', runtimeOwnerEnvironmentId: 'other' }
    }
  ])(
    'refuses to reload a paired SSH tab through $rival once its owner is gone',
    async ({ repo, worktree }) => {
      const { store, fetchPRCheckDetails, setCatalog } = createOwnerStore({
        repos: [pairedRepo],
        worktreesByRepo: { 'repo-1': [pairedWorktree] }
      })
      const tabId = open(store)
      setCatalog({ repos: [repo], worktreesByRepo: { 'repo-1': [worktree] } })

      await store.getState().reloadOpenCheckRunDetailsTab(tabId)

      expect(fetchPRCheckDetails).not.toHaveBeenCalled()
      expect(store.getState().openFiles[0].checkRunDetails).toMatchObject({
        loading: false,
        error: 'Repository details are unavailable for this check.'
      })
    }
  )

  it.each([
    { openedThrough: 'its server host', activeHost: 'runtime:server' },
    { openedThrough: 'the catalog', activeHost: undefined }
  ] as const)(
    'reloads a legacy paired SSH workspace opened through $openedThrough',
    async ({ activeHost }) => {
      const { store, fetchPRCheckDetails } = createOwnerStore({
        activeWorkspaceExecutionHostId: activeHost,
        repos: [pairedRepo],
        // Older paired listings stamp only the SSH machine; the server owner comes from the repo.
        worktreesByRepo: {
          'repo-1': [{ ...pairedWorktree, runtimeOwnerEnvironmentId: undefined }]
        }
      })
      const tabId = open(store)

      await store.getState().reloadOpenCheckRunDetailsTab(tabId)

      expect(fetchPRCheckDetails).toHaveBeenCalledWith(
        '/remote',
        expect.objectContaining({ checkRunId: 42 }),
        { repoId: 'repo-1', repoOwnerExecutionHostId: 'runtime:server' }
      )
    }
  )

  it('refuses to reload an unpinned tab when a detected checkout rivals the tracked row', async () => {
    const localRepo = { id: 'repo-1', path: '/repo' }
    const { store, fetchPRCheckDetails } = createOwnerStore({
      repos: [localRepo, { ...localRepo, path: '/remote', executionHostId: 'runtime:server' }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo' }] },
      detectedWorktreesByRepo: {
        'repo-1': {
          repoId: 'repo-1',
          authoritative: true,
          source: 'git',
          worktrees: [
            {
              id: 'wt-1',
              repoId: 'repo-1',
              path: '/remote',
              hostId: 'runtime:server',
              runtimeOwnerEnvironmentId: 'server'
            }
          ]
        }
      }
    })
    const tabId = open(store)

    await store.getState().reloadOpenCheckRunDetailsTab(tabId)

    expect(fetchPRCheckDetails).not.toHaveBeenCalled()
    expect(store.getState().openFiles[0]).toMatchObject({
      operationProvenance: undefined,
      checkRunDetails: { error: 'Repository details are unavailable for this check.' }
    })
  })

  it('delivers a sidebar request to its tab after the user selects the local twin', async () => {
    const localRepo = { id: 'repo-1', path: '/repo' }
    const localWorktree = { id: 'wt-1', repoId: 'repo-1', path: '/repo' }
    const remoteWorktree = {
      ...localWorktree,
      path: '/remote',
      hostId: 'runtime:server',
      runtimeOwnerEnvironmentId: 'server'
    }
    const { store } = createOwnerStore({
      activeWorkspaceExecutionHostId: 'runtime:server',
      repos: [localRepo, { ...localRepo, path: '/remote', executionHostId: 'runtime:server' }],
      worktreesByRepo: { 'repo-1': [localWorktree, remoteWorktree] }
    })
    const remoteTabId = open(store)
    const requestId = createCheckRunDetailsRequestId()
    store.getState().patchOpenCheckRunDetails('wt-1', 'repo:99', check, {
      requestId,
      details: null,
      loading: true,
      error: null
    })

    store.setState({ activeWorkspaceExecutionHostId: 'local' })
    store.getState().patchOpenCheckRunDetails('wt-1', 'repo:99', check, {
      requestId,
      details,
      loading: false,
      error: null
    })

    expect(store.getState().openFiles.find((file) => file.id === remoteTabId)).toMatchObject({
      checkRunDetails: { requestId, loading: false, details: { title: 'Build passed' } }
    })
  })
})
