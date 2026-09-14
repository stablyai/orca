import { createStore, type StoreApi } from 'zustand/vanilla'
import { describe, expect, it, vi } from 'vitest'
import { createEditorSlice } from './editor'
import { createEditorTabsStore } from './editor-slice-test-harness'
import type { AppState } from '../types'

const { toastErrorMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: toastErrorMock }
}))

const { notifyHostOfMirroredEditorCloseMock } = vi.hoisted(() => ({
  notifyHostOfMirroredEditorCloseMock: vi.fn()
}))
vi.mock('@/runtime/close-mirrored-editor-tab', () => ({
  notifyHostOfMirroredEditorClose: (...args: unknown[]) =>
    notifyHostOfMirroredEditorCloseMock(...args)
}))

const loadGitLabJobLogDetailsMock = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/gitlab-job-trace-client', () => ({
  loadGitLabJobLogDetails: loadGitLabJobLogDetailsMock
}))

describe('createEditorSlice conflict status reconciliation', () => {
  it('reloads an open check-details tab from the hosted provider', async () => {
    const fetchPRCheckDetails = vi.fn().mockResolvedValue({
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
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = createStore<any>()((...args: any[]) => ({
      activeWorktreeId: 'wt-1',
      repos: [{ id: 'repo-1', path: '/repo' }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo' }] },
      fetchPRCheckDetails,
      ...createEditorSlice(...(args as Parameters<typeof createEditorSlice>))
    })) as unknown as StoreApi<AppState>
    const check = {
      name: 'verify',
      status: 'completed' as const,
      conclusion: 'failure' as const,
      url: null,
      checkRunId: 42
    }
    const githubRepository = { owner: 'upstream', repo: 'project' }

    store.getState().openCheckRunDetails('wt-1', 'repo:99', check, {
      details: null,
      loading: false,
      error: null,
      githubRepository
    })

    await store.getState().reloadOpenCheckRunDetailsTab('wt-1::check-details::check-run:42')

    expect(fetchPRCheckDetails).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({
        checkRunId: 42,
        checkName: 'verify',
        prRepo: githubRepository
      }),
      { repoId: 'repo-1' }
    )
    expect(store.getState().openFiles).toContainEqual(
      expect.objectContaining({
        id: 'wt-1::check-details::check-run:42',
        checkRunDetails: expect.objectContaining({
          loading: false,
          details: expect.objectContaining({ title: 'Build passed', conclusion: 'success' })
        })
      })
    )
  })

  it('stops loading when an open check-details tab loses its repository', async () => {
    const fetchPRCheckDetails = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = createStore<any>()((...args: any[]) => ({
      activeWorktreeId: 'wt-1',
      repos: [],
      worktreesByRepo: {},
      fetchPRCheckDetails,
      ...createEditorSlice(...(args as Parameters<typeof createEditorSlice>))
    })) as unknown as StoreApi<AppState>
    const check = {
      name: 'verify',
      status: 'completed' as const,
      conclusion: 'failure' as const,
      url: null,
      checkRunId: 42
    }

    store.getState().openCheckRunDetails('wt-1', 'repo:99', check, {
      details: null,
      loading: true,
      error: null
    })
    await store.getState().reloadOpenCheckRunDetailsTab('wt-1::check-details::check-run:42')

    expect(fetchPRCheckDetails).not.toHaveBeenCalled()
    expect(store.getState().openFiles).toContainEqual(
      expect.objectContaining({
        id: 'wt-1::check-details::check-run:42',
        checkRunDetails: expect.objectContaining({
          loading: false,
          error: 'Repository details are unavailable for this check.'
        })
      })
    )
  })

  // Regression for #7732: refreshing a GitLab job tab through the GitHub check-runs
  // API returns null and blanks the tab the user just asked to reload.
  it('reloads an open GitLab job tab through the job trace client', async () => {
    loadGitLabJobLogDetailsMock.mockReset()
    loadGitLabJobLogDetailsMock.mockResolvedValue({
      name: 'test: unit',
      status: 'completed',
      conclusion: 'failure',
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
          id: 42,
          name: 'test: unit',
          status: 'completed',
          conclusion: 'failure',
          startedAt: null,
          completedAt: null,
          url: null,
          logTail: 'ERROR: Job failed: exit code 1',
          steps: []
        }
      ]
    })
    const fetchPRCheckDetails = vi.fn().mockResolvedValue(null)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = createStore<any>()((...args: any[]) => ({
      activeWorktreeId: 'wt-1',
      repos: [{ id: 'repo-1', path: '/repo' }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo' }] },
      settings: { activeRuntimeEnvironmentId: null },
      fetchPRCheckDetails,
      ...createEditorSlice(...(args as Parameters<typeof createEditorSlice>))
    })) as unknown as StoreApi<AppState>
    const check = {
      name: 'test: unit',
      status: 'completed' as const,
      conclusion: 'failure' as const,
      url: null,
      gitlabJobId: 42
    }

    store.getState().openCheckRunDetails('wt-1', 'repo:99', check, {
      details: null,
      loading: false,
      error: null
    })

    await store.getState().reloadOpenCheckRunDetailsTab('wt-1::check-details::gitlab-job:42')

    expect(fetchPRCheckDetails).not.toHaveBeenCalled()
    expect(loadGitLabJobLogDetailsMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: '/repo', repoId: 'repo-1', check })
    )
    expect(store.getState().openFiles).toContainEqual(
      expect.objectContaining({
        id: 'wt-1::check-details::gitlab-job:42',
        checkRunDetails: expect.objectContaining({
          loading: false,
          error: null,
          details: expect.objectContaining({
            jobs: [expect.objectContaining({ logTail: 'ERROR: Job failed: exit code 1' })]
          })
        })
      })
    )
  })

  // Regression for #7732: a fork MR's job lives in the source project, so reloading
  // without the stored project ref requests the trace from the wrong project.
  it('reloads a fork MR job tab with the stored GitLab project ref', async () => {
    loadGitLabJobLogDetailsMock.mockReset()
    loadGitLabJobLogDetailsMock.mockResolvedValue(null)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = createStore<any>()((...args: any[]) => ({
      activeWorktreeId: 'wt-1',
      repos: [{ id: 'repo-1', path: '/repo' }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo' }] },
      settings: { activeRuntimeEnvironmentId: null },
      fetchPRCheckDetails: vi.fn().mockResolvedValue(null),
      ...createEditorSlice(...(args as Parameters<typeof createEditorSlice>))
    })) as unknown as StoreApi<AppState>
    const check = {
      name: 'test: unit',
      status: 'completed' as const,
      conclusion: 'failure' as const,
      url: null,
      gitlabJobId: 77
    }
    const projectRef = { host: 'gitlab.com', path: 'contributor/fork' }

    store.getState().openCheckRunDetails('wt-1', 'repo:99', check, {
      details: null,
      loading: false,
      error: null,
      gitlabProjectRef: projectRef
    })

    await store.getState().reloadOpenCheckRunDetailsTab('wt-1::check-details::gitlab-job:77')

    expect(loadGitLabJobLogDetailsMock).toHaveBeenCalledWith(
      expect.objectContaining({ check, projectRef })
    )
  })

  it('keeps a stored GitLab project ref when a patch omits it', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = createStore<any>()((...args: any[]) => ({
      activeWorktreeId: 'wt-1',
      ...createEditorSlice(...(args as Parameters<typeof createEditorSlice>))
    })) as unknown as StoreApi<AppState>
    const check = {
      name: 'test: unit',
      status: 'completed' as const,
      conclusion: 'failure' as const,
      url: null,
      gitlabJobId: 77
    }
    const projectRef = { host: 'gitlab.com', path: 'contributor/fork' }

    store.getState().openCheckRunDetails('wt-1', 'repo:99', check, {
      details: null,
      loading: false,
      error: null,
      gitlabProjectRef: projectRef
    })
    store.getState().patchOpenCheckRunDetails('wt-1', 'repo:99', check, {
      details: null,
      loading: true,
      error: null,
      gitlabProjectRef: null
    })

    expect(
      store.getState().openFiles.find((file) => file.id === 'wt-1::check-details::gitlab-job:77')
        ?.checkRunDetails?.gitlabProjectRef
    ).toEqual(projectRef)
  })

  it('patches an open check-details tab without changing the active file', () => {
    const store = createEditorTabsStore()
    const check = {
      name: 'verify',
      status: 'completed' as const,
      conclusion: 'failure' as const,
      url: null,
      checkRunId: 42
    }

    store.getState().openCheckRunDetails('wt-1', 'repo:99', check, {
      details: null,
      loading: true,
      error: null
    })
    store.getState().openFile({
      filePath: '/repo/other.ts',
      relativePath: 'other.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })

    store.getState().patchOpenCheckRunDetails('wt-1', 'repo:99', check, {
      details: {
        name: 'verify',
        status: 'completed',
        conclusion: 'failure',
        url: null,
        detailsUrl: null,
        startedAt: null,
        completedAt: null,
        title: 'Build failed',
        summary: null,
        text: null,
        annotations: [],
        jobs: []
      },
      loading: false,
      error: null
    })

    expect(store.getState().activeFileId).toBe('/repo/other.ts')
    expect(store.getState().openFiles).toContainEqual(
      expect.objectContaining({
        id: 'wt-1::check-details::check-run:42',
        checkRunDetails: expect.objectContaining({
          loading: false,
          details: expect.objectContaining({ title: 'Build failed' })
        })
      })
    )
  })

  it('ignores a stale check-details request after the tab context changes', () => {
    const store = createEditorTabsStore()
    const check = {
      name: 'verify',
      status: 'completed' as const,
      conclusion: 'failure' as const,
      url: null,
      checkRunId: 42
    }

    store.getState().openCheckRunDetails('wt-1', 'repo:old', check, {
      details: null,
      loading: true,
      error: null
    })
    store.getState().openCheckRunDetails('wt-1', 'repo:new', check, {
      details: null,
      loading: true,
      error: null
    })
    store.getState().patchOpenCheckRunDetails('wt-1', 'repo:old', check, {
      details: null,
      loading: false,
      error: 'stale request failed'
    })

    expect(
      store.getState().openFiles.find((file) => file.id === 'wt-1::check-details::check-run:42')
        ?.checkRunDetails
    ).toEqual(
      expect.objectContaining({ contextKey: 'repo:new', details: null, loading: true, error: null })
    )
  })

  it('ignores an older check-details request in the same context', () => {
    const store = createEditorTabsStore()
    const check = {
      name: 'verify',
      status: 'completed' as const,
      conclusion: 'failure' as const,
      url: null,
      checkRunId: 42
    }

    store.getState().openCheckRunDetails('wt-1', 'repo:99', check, {
      requestId: 1,
      details: null,
      loading: true,
      error: null
    })
    store.getState().patchOpenCheckRunDetails('wt-1', 'repo:99', check, {
      requestId: 2,
      details: null,
      loading: true,
      error: null
    })
    store.getState().patchOpenCheckRunDetails('wt-1', 'repo:99', check, {
      requestId: 1,
      details: null,
      loading: false,
      error: 'stale request failed'
    })

    expect(
      store.getState().openFiles.find((file) => file.id === 'wt-1::check-details::check-run:42')
        ?.checkRunDetails
    ).toEqual(expect.objectContaining({ requestId: 2, details: null, loading: true, error: null }))
  })

  it('does not reopen a check-details tab with an older sidebar snapshot', () => {
    const store = createEditorTabsStore()
    const check = {
      name: 'verify',
      status: 'completed' as const,
      conclusion: 'failure' as const,
      url: null,
      checkRunId: 42
    }

    store.getState().openCheckRunDetails('wt-1', 'repo:99', check, {
      requestId: 2,
      details: null,
      loading: false,
      error: 'newer result'
    })
    store.getState().openFile({
      filePath: '/repo/other.ts',
      relativePath: 'other.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().openCheckRunDetails('wt-1', 'repo:99', check, {
      requestId: 1,
      details: null,
      loading: false,
      error: 'stale result'
    })

    expect(store.getState().activeFileId).toBe('wt-1::check-details::check-run:42')
    expect(
      store.getState().openFiles.find((file) => file.id === 'wt-1::check-details::check-run:42')
        ?.checkRunDetails
    ).toEqual(expect.objectContaining({ requestId: 2, error: 'newer result' }))
  })

  it('opens check full details as a center-pane editor tab', () => {
    const store = createEditorTabsStore()
    const check = {
      name: 'verify',
      status: 'completed' as const,
      conclusion: 'failure' as const,
      url: null,
      checkRunId: 42
    }

    store.getState().openCheckRunDetails('wt-1', 'repo:99', check, {
      details: {
        name: 'verify',
        status: 'completed',
        conclusion: 'failure',
        url: null,
        detailsUrl: null,
        startedAt: null,
        completedAt: null,
        title: 'Build failed',
        summary: null,
        text: null,
        annotations: [],
        jobs: []
      },
      loading: false,
      error: null
    })

    expect(store.getState().activeFileId).toBe('wt-1::check-details::check-run:42')
    expect(store.getState().openFiles).toContainEqual(
      expect.objectContaining({
        id: 'wt-1::check-details::check-run:42',
        mode: 'check-details',
        relativePath: 'verify',
        checkRunDetails: expect.objectContaining({
          contextKey: 'repo:99',
          check,
          details: expect.objectContaining({ title: 'Build failed' })
        })
      })
    )
    expect(store.getState().unifiedTabsByWorktree['wt-1']).toContainEqual(
      expect.objectContaining({
        entityId: 'wt-1::check-details::check-run:42',
        contentType: 'check-details',
        label: 'verify'
      })
    )
  })
})
