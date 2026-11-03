import { afterEach, describe, expect, it, vi } from 'vitest'
import * as rpc from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { createTestStore, TEST_REPO } from '../slices/store-test-helpers'
import { fetchActionsRuns } from './actions-requests'
import { startActionsArtifactDownload } from './actions-artifact-requests'
import { ACTIONS_ARTIFACT_CLIENT_TIMEOUT_MS } from '../../../../shared/github/actions-artifact-types'
import { actionsRepoProbeKey } from './actions-request-identity'
import type { ActionsPage, ActionsRun } from '../../../../shared/github/actions-types'

const context = { repoId: TEST_REPO.id, repoPath: TEST_REPO.path }
const page: ActionsPage<ActionsRun> = {
  repository: { owner: 'acme', repo: 'widgets', host: 'github.com' },
  items: [],
  page: 1,
  perPage: 50,
  hasNextPage: false,
  limitReached: false,
  totalCount: 0
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe('Actions request ownership', () => {
  it('allows a runtime-owned artifact to outlast the metadata request deadline', async () => {
    const store = createTestStore()
    store.setState({ repos: [{ ...TEST_REPO, executionHostId: 'runtime:owner' }] })
    const call = vi
      .spyOn(rpc, 'callRuntimeRpc')
      .mockResolvedValue({ transferId: 'artifact', sizeBytes: 4, fileName: 'artifact.zip' })
    await startActionsArtifactDownload(store.getState(), context, {
      repository: page.repository,
      runId: 1,
      artifactId: 2
    })
    expect(call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'owner' },
      'github.startActionsArtifactDownload',
      { repo: TEST_REPO.id, repository: page.repository, runId: 1, artifactId: 2 },
      { timeoutMs: ACTIONS_ARTIFACT_CLIENT_TIMEOUT_MS }
    )
  })
  it('routes runtime-owned repos to their owner despite the active runtime focus', async () => {
    const store = createTestStore()
    store.setState({
      repos: [TEST_REPO, { ...TEST_REPO, id: 'owned-repo', executionHostId: 'runtime:owner' }]
    })
    const call = vi.spyOn(rpc, 'callRuntimeRpc').mockResolvedValue(page)
    await fetchActionsRuns(store.getState(), { ...context, repoId: 'owned-repo' }, {})
    expect(call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'owner' },
      'github.actionsRuns',
      { repo: 'owned-repo' },
      { timeoutMs: 30000 }
    )
  })
  it('degrades an older host without a local fallback', async () => {
    const store = createTestStore()
    store.setState({ repos: [{ ...TEST_REPO, executionHostId: 'runtime:old' }] })
    vi.spyOn(rpc, 'callRuntimeRpc').mockRejectedValue(
      new RuntimeRpcCallError({
        id: 'test',
        ok: false,
        error: { code: 'method_not_found', message: 'Unknown method' }
      })
    )
    const local = vi.fn()
    vi.stubGlobal('window', { api: { gh: { actionsRuns: local } } })
    await expect(fetchActionsRuns(store.getState(), context, {})).rejects.toThrow('Orca update')
    expect(local).not.toHaveBeenCalled()
  })
  it('keeps ordinary SSH API reads client-hosted and coalesces only matching owners', async () => {
    const store = createTestStore()
    store.setState({ repos: [{ ...TEST_REPO, connectionId: 'ssh-one' }] })
    let resolve: (value: ActionsPage<ActionsRun>) => void = () => {}
    const local = vi.fn().mockImplementation(
      () =>
        new Promise<ActionsPage<ActionsRun>>((done) => {
          resolve = done
        })
    )
    vi.stubGlobal('window', { api: { gh: { actionsRuns: local } } })
    const first = fetchActionsRuns(store.getState(), context, {})
    const second = fetchActionsRuns(store.getState(), context, {})
    expect(local).toHaveBeenCalledTimes(1)
    resolve(page)
    await Promise.all([first, second])
    store.setState({ repos: [{ ...TEST_REPO, connectionId: 'ssh-two' }] })
    const other = fetchActionsRuns(store.getState(), context, {})
    expect(local).toHaveBeenCalledTimes(2)
    resolve(page)
    await other
  })
  it('rejects an open tab whose execution host or account changed', async () => {
    const store = createTestStore()
    store.setState({ repos: [TEST_REPO] })
    const pinned = { ...context, ownerKey: actionsRepoProbeKey(TEST_REPO) }
    store.setState({ repos: [{ ...TEST_REPO, executionHostId: 'runtime:new' }] })
    await expect(fetchActionsRuns(store.getState(), pinned, {})).rejects.toThrow(
      'host or account changed'
    )
  })
})
