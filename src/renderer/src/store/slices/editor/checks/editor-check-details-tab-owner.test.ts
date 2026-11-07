import type { StoreApi } from 'zustand/vanilla'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEditorTabsStore } from '../editor-slice-test-harness'
import { makeWorktree, TEST_REPO } from '../../worktrees-slice-test-fixtures'
import type { AppState } from '../../../types'
import type { PRCheckRunDetails } from '../../../../../../shared/github/check-types'

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
const pairedRepo: AppState['repos'][number] = {
  ...TEST_REPO,
  id: 'repo-1',
  path: '/remote',
  executionHostId: 'runtime:server',
  connectionId: 'builder'
}
const pairedWorktree = makeWorktree({
  id: 'wt-1',
  repoId: 'repo-1',
  path: '/remote',
  hostId: 'ssh:builder',
  runtimeOwnerEnvironmentId: 'server'
})

function createOwnerStore(state: Partial<AppState>) {
  const fetchPRCheckDetails = vi.fn().mockResolvedValue(details)
  const store = createEditorTabsStore()
  store.setState({
    activeWorktreeId: 'wt-1',
    detectedWorktreesByRepo: {},
    settings: null,
    fetchPRCheckDetails,
    ...state
  })
  const setCatalog = (catalog: Partial<AppState>) => store.setState(catalog)
  return { store, fetchPRCheckDetails, setCatalog }
}

function open(store: StoreApi<AppState>, worktreeId = 'wt-1'): string {
  store.getState().openCheckRunDetails(worktreeId, 'repo:99', check, {
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

  it.each(['tracked', 'detected'] as const)(
    'reloads a pinned direct SSH tab when its %s listing shares a target with a server proxy',
    async (source) => {
      const directRepo = { ...pairedRepo, path: '/direct', executionHostId: 'ssh:builder' as const }
      const directWorkspace = {
        ...pairedWorktree,
        id: 'repo-1::/direct',
        path: '/direct',
        runtimeOwnerEnvironmentId: undefined
      }
      const listings = (
        rows: AppState['worktreesByRepo'][string]
      ): Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo'> => ({
        worktreesByRepo: source === 'tracked' ? { 'repo-1': rows } : {},
        detectedWorktreesByRepo:
          source === 'detected'
            ? {
                'repo-1': {
                  repoId: 'repo-1',
                  authoritative: true,
                  source: 'git',
                  worktrees: rows.map((row) => ({
                    ...row,
                    ownership: 'external',
                    selectedCheckout: false,
                    visible: true
                  }))
                }
              }
            : {}
      })
      const { store, fetchPRCheckDetails, setCatalog } = createOwnerStore({
        activeWorktreeId: directWorkspace.id,
        activeWorkspaceExecutionHostId: 'ssh:builder',
        repos: [directRepo, pairedRepo],
        ...listings([directWorkspace])
      })
      const tabId = open(store, directWorkspace.id)
      expect(store.getState().openFiles[0].operationProvenance?.generation.route).toEqual({
        executionHostId: 'ssh:builder',
        runtimeEnvironmentId: null
      })
      store.setState({ activeWorkspaceExecutionHostId: 'runtime:server' })

      await store.getState().reloadOpenCheckRunDetailsTab(tabId)

      expect(fetchPRCheckDetails).toHaveBeenCalledWith(
        '/direct',
        expect.objectContaining({ checkRunId: 42 }),
        { repoId: 'repo-1', repoOwnerExecutionHostId: 'ssh:builder' }
      )
      fetchPRCheckDetails.mockClear()
      setCatalog({ repos: [pairedRepo] })
      await store.getState().reloadOpenCheckRunDetailsTab(tabId)
      expect(fetchPRCheckDetails).not.toHaveBeenCalled()

      setCatalog({
        repos: [directRepo, pairedRepo],
        ...listings([directWorkspace, { ...pairedWorktree, id: directWorkspace.id }])
      })
      await store.getState().reloadOpenCheckRunDetailsTab(tabId)
      expect(fetchPRCheckDetails).not.toHaveBeenCalled()

      const pairedTabId = open(store, directWorkspace.id)
      await store.getState().reloadOpenCheckRunDetailsTab(pairedTabId)
      expect(fetchPRCheckDetails).toHaveBeenCalledWith(
        '/remote',
        expect.objectContaining({ checkRunId: 42 }),
        { repoId: 'repo-1', repoOwnerExecutionHostId: 'runtime:server' }
      )
    }
  )

  it('refuses to reload an unpinned tab when a detected checkout rivals the tracked row', async () => {
    const localRepo = { ...TEST_REPO, id: 'repo-1', path: '/repo' }
    const { store, fetchPRCheckDetails } = createOwnerStore({
      repos: [localRepo, { ...localRepo, path: '/remote', executionHostId: 'runtime:server' }],
      worktreesByRepo: {
        'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo' })]
      },
      detectedWorktreesByRepo: {
        'repo-1': {
          repoId: 'repo-1',
          authoritative: true,
          source: 'git',
          worktrees: [
            {
              ...makeWorktree({
                id: 'wt-1',
                repoId: 'repo-1',
                path: '/remote',
                hostId: 'runtime:server',
                runtimeOwnerEnvironmentId: 'server'
              }),
              ownership: 'external',
              selectedCheckout: false,
              visible: true
            }
          ]
        }
      }
    })
    const tabId = open(store)

    await store.getState().reloadOpenCheckRunDetailsTab(tabId)

    expect(fetchPRCheckDetails).not.toHaveBeenCalled()
    expect(store.getState().openFiles[0]).toMatchObject({
      operationProvenance: undefined
    })
  })
})
