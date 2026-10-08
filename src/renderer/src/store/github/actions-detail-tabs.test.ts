import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEditorTabsStore } from '../slices/editor-slice-test-harness'
import { loadActionsDetailTab } from './actions-detail-tabs'
import { actionsRepoProbeKey } from './actions-request-identity'
import { buildCheckRunDetailsTabId } from '@/components/editor/check-run-details-tab'
import type { ActionsRunDetails } from '../../../../shared/github/actions-types'

const repository = { owner: 'acme', repo: 'widgets', host: 'github.com' }
const run = {
  id: 9,
  workflowId: 5,
  runNumber: 1,
  runAttempt: 1,
  name: 'Build',
  displayTitle: 'Build',
  headBranch: 'main',
  headSha: null,
  event: 'push',
  actor: null,
  status: 'completed',
  conclusion: 'success',
  htmlUrl: null,
  createdAt: null,
  updatedAt: null,
  runStartedAt: null
}
function details(page = 1, attempt = 1): ActionsRunDetails {
  return {
    name: 'Build',
    status: 'completed',
    conclusion: 'success',
    url: null,
    detailsUrl: null,
    startedAt: null,
    completedAt: null,
    title: null,
    summary: null,
    text: null,
    annotations: [],
    jobs: [
      {
        id: page,
        name: `job-${page}`,
        status: 'completed',
        conclusion: 'success',
        startedAt: null,
        completedAt: null,
        url: null,
        logTail: null,
        steps: []
      }
    ],
    actions: {
      repository,
      run: { ...run, runAttempt: attempt },
      jobsPage: page,
      hasNextPage: true,
      totalJobs: 101,
      limitReached: false,
      jobsError: null,
      logWarnings: []
    }
  }
}
function setup() {
  const store = createEditorTabsStore()
  const check = {
    name: 'Build',
    status: 'completed' as const,
    conclusion: 'success' as const,
    url: null,
    workflowRunId: 9,
    actionsIdentity: 'repository-one'
  }
  const repo = store.getState().repos[0]
  store.getState().openCheckRunDetails('folder:parent', 'actions-owner', check, {
    details: details(),
    loading: false,
    error: null,
    githubRepository: repository,
    actionsContext: { repoId: repo.id, repoPath: repo.path, ownerKey: actionsRepoProbeKey(repo) }
  })
  return { store, fileId: buildCheckRunDetailsTabId('folder:parent', check) }
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
describe('whole-run editor state', () => {
  it('replaces old jobs with authoritative new-attempt metadata when its first page fails', async () => {
    const { store, fileId } = setup()
    const next = details(1, 2)
    next.jobs = []
    next.actions.jobsError = 'New attempt jobs unavailable'
    next.actions.hasNextPage = false
    const read = vi.fn().mockResolvedValue(next)
    vi.stubGlobal('window', { api: { gh: { actionsRunDetails: read } } })
    await loadActionsDetailTab(store.getState, fileId, true)
    const current = store.getState().openFiles[0].checkRunDetails
    expect(current?.details?.actions?.run.runAttempt).toBe(2)
    expect(current?.details?.actions?.jobsError).toBe('New attempt jobs unavailable')
    expect(current?.details?.jobs).toEqual([])
    expect(current?.error).toBeNull()
  })
  it('reloads a folder-parent tab through the selected repo without a PR or name narrowing', async () => {
    const { store, fileId } = setup()
    const read = vi.fn().mockResolvedValue(details())
    vi.stubGlobal('window', { api: { gh: { actionsRunDetails: read } } })
    await store.getState().reloadOpenCheckRunDetailsTab(fileId)
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'repo-1',
        repoPath: '/repo',
        runId: 9,
        repository,
        jobsPage: 1,
        noCache: true
      })
    )
    expect(read.mock.calls[0][0]).not.toHaveProperty('checkName')
  })
  it('keeps prior jobs on page errors, and replaces them when an attempt changes', async () => {
    const { store, fileId } = setup()
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        ...details(2),
        actions: { ...details(2).actions, jobsError: 'page failed' }
      })
      .mockResolvedValueOnce(details(1, 2))
    vi.stubGlobal('window', { api: { gh: { actionsRunDetails: read } } })
    await loadActionsDetailTab(store.getState, fileId, true)
    expect(store.getState().openFiles[0].checkRunDetails?.details?.jobs[0].name).toBe('job-1')
    expect(store.getState().openFiles[0].checkRunDetails?.error).toBe('page failed')
    await loadActionsDetailTab(store.getState, fileId, true)
    expect(store.getState().openFiles[0].checkRunDetails?.details?.actions?.run.runAttempt).toBe(2)
    expect(store.getState().openFiles[0].checkRunDetails?.details?.jobs).toHaveLength(1)
  })
  it('rejects a late response after its execution owner changes', async () => {
    const { store, fileId } = setup()
    let resolve: (value: ActionsRunDetails) => void = () => {}
    const read = vi.fn().mockImplementation(
      () =>
        new Promise<ActionsRunDetails>((done) => {
          resolve = done
        })
    )
    vi.stubGlobal('window', { api: { gh: { actionsRunDetails: read } } })
    const pending = loadActionsDetailTab(store.getState, fileId)
    store.setState({
      repos: store.getState().repos.map((repo) => ({ ...repo, executionHostId: 'runtime:another' }))
    })
    resolve(details(1, 2))
    await pending
    expect(store.getState().openFiles[0].checkRunDetails?.error).toContain(
      'host or account changed'
    )
    expect(store.getState().openFiles[0].checkRunDetails?.details?.actions?.run.runAttempt).toBe(1)
  })
  it('prevents an older paginated response from replacing a refreshed generation', async () => {
    const { store, fileId } = setup()
    let resolve: (value: ActionsRunDetails) => void = () => {}
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ActionsRunDetails>((done) => {
            resolve = done
          })
      )
      .mockResolvedValueOnce(details(1, 2))
    vi.stubGlobal('window', { api: { gh: { actionsRunDetails: read } } })
    const oldPage = loadActionsDetailTab(store.getState, fileId, true)
    await loadActionsDetailTab(store.getState, fileId)
    resolve(details(2))
    await oldPage
    expect(store.getState().openFiles[0].checkRunDetails?.details?.actions?.run.runAttempt).toBe(2)
    expect(store.getState().openFiles[0].checkRunDetails?.details?.jobs).toHaveLength(1)
  })
})
