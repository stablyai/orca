import { describe, expect, it, vi } from 'vitest'
import { createEditorTabsStore } from './editor-slice-test-harness'
import { makeWorktree, TEST_REPO } from './worktrees-slice-test-fixtures'
import { drawTabsFromMain } from './tabs-drawn-from-main.test-fixture'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

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
  it.each(['local', 'runtime:server'] as const)(
    'reloads a check-details tab opened on %s after selecting its twin',
    async (executionHostId) => {
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
      const store = createEditorTabsStore()
      const localRepo = store.getState().repos[0]
      const localWorktree = store.getState().worktreesByRepo['repo-1'][0]
      store.setState({
        activeWorkspaceExecutionHostId: executionHostId,
        repos: [localRepo, { ...localRepo, path: '/remote', executionHostId: 'runtime:server' }],
        worktreesByRepo: {
          'repo-1': [
            localWorktree,
            {
              ...localWorktree,
              path: '/remote',
              hostId: 'runtime:server',
              runtimeOwnerEnvironmentId: 'server'
            }
          ]
        },
        fetchPRCheckDetails
      })
      const main = await drawTabsFromMain(store)
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
      await main.settle()

      const tabId =
        executionHostId === 'local'
          ? 'wt-1::check-details::check-run:42'
          : 'wt-1::check-details@runtime:server::check-run:42'

      store.setState({
        activeWorkspaceExecutionHostId: executionHostId === 'local' ? 'runtime:server' : 'local'
      })
      await store.getState().reloadOpenCheckRunDetailsTab(tabId)

      expect(fetchPRCheckDetails).toHaveBeenCalledWith(
        executionHostId === 'local' ? '/repo' : '/remote',
        expect.objectContaining({
          checkRunId: 42,
          checkName: 'verify',
          prRepo: githubRepository
        }),
        { repoId: 'repo-1', repoOwnerExecutionHostId: executionHostId }
      )
      expect(store.getState().openFiles).toContainEqual(
        expect.objectContaining({
          id: tabId,
          checkRunDetails: expect.objectContaining({
            loading: false,
            details: expect.objectContaining({ title: 'Build passed', conclusion: 'success' })
          })
        })
      )
      main.close()
    }
  )

  it('keeps a check reopened on a twin host in its own tab with its own project', async () => {
    const fetchPRCheckDetails = vi.fn().mockResolvedValue(null)
    const store = createEditorTabsStore()
    const localRepo = store.getState().repos[0]
    const localWorktree = store.getState().worktreesByRepo['repo-1'][0]
    store.setState({
      activeWorkspaceExecutionHostId: 'local',
      repos: [localRepo, { ...localRepo, path: '/remote', executionHostId: 'runtime:server' }],
      worktreesByRepo: {
        'repo-1': [
          localWorktree,
          {
            ...localWorktree,
            path: '/remote',
            hostId: 'runtime:server',
            runtimeOwnerEnvironmentId: 'server'
          }
        ]
      },
      fetchPRCheckDetails
    })
    const main = await drawTabsFromMain(store)
    const check = {
      name: 'verify',
      status: 'completed' as const,
      conclusion: 'failure' as const,
      url: null,
      checkRunId: 42
    }
    const localProject = { owner: 'local-org', repo: 'project' }
    const remoteProject = { owner: 'remote-org', repo: 'project' }

    store.getState().openCheckRunDetails('wt-1', 'repo:99', check, {
      details: null,
      loading: false,
      error: null,
      githubRepository: localProject
    })
    await main.settle()
    store.setState({ activeWorkspaceExecutionHostId: 'runtime:server' })
    store.getState().openCheckRunDetails('wt-1', 'repo:99', check, {
      details: null,
      loading: false,
      error: null,
      githubRepository: remoteProject
    })
    await main.settle()
    // A sidebar patch on the selected host must not rewrite its twin's tab.
    store.getState().patchOpenCheckRunDetails('wt-1', 'repo:99', check, {
      details: null,
      loading: false,
      error: 'remote patch'
    })

    const localTabId = 'wt-1::check-details::check-run:42'
    const remoteTabId = 'wt-1::check-details@runtime:server::check-run:42'
    expect(
      store
        .getState()
        .openFiles.filter((file) => file.mode === 'check-details')
        .map((file) => [
          file.id,
          file.checkRunDetails?.githubRepository,
          file.checkRunDetails?.error
        ])
    ).toEqual([
      [localTabId, localProject, null],
      [remoteTabId, remoteProject, 'remote patch']
    ])

    await store.getState().reloadOpenCheckRunDetailsTab(localTabId)
    await store.getState().reloadOpenCheckRunDetailsTab(remoteTabId)

    expect(fetchPRCheckDetails).toHaveBeenNthCalledWith(
      1,
      '/repo',
      expect.objectContaining({ prRepo: localProject }),
      { repoId: 'repo-1', repoOwnerExecutionHostId: 'local' }
    )
    expect(fetchPRCheckDetails).toHaveBeenNthCalledWith(
      2,
      '/remote',
      expect.objectContaining({ prRepo: remoteProject }),
      { repoId: 'repo-1', repoOwnerExecutionHostId: 'runtime:server' }
    )
    main.close()
  })

  it.each(['local', 'runtime:server'] as const)(
    'reloads a check-details tab for a detected %s checkout',
    async (executionHostId) => {
      const fetchPRCheckDetails = vi.fn().mockResolvedValue(null)
      const remote = executionHostId !== 'local'
      const repoPath = remote ? '/remote' : '/repo'
      const store = createEditorTabsStore()
      store.setState({
        activeWorktreeId: 'wt-1',
        repos: [
          {
            ...TEST_REPO,
            id: 'repo-1',
            path: repoPath,
            ...(remote ? { executionHostId: 'runtime:server' as const } : {})
          }
        ],
        worktreesByRepo: {},
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
                  path: repoPath,
                  ...(remote
                    ? { hostId: 'runtime:server' as const, runtimeOwnerEnvironmentId: 'server' }
                    : {})
                }),
                ownership: 'external',
                selectedCheckout: false,
                visible: true
              }
            ]
          }
        },
        settings: null,
        fetchPRCheckDetails
      })
      const check = {
        name: 'verify',
        status: 'completed' as const,
        conclusion: 'failure' as const,
        url: null,
        checkRunId: 42
      }

      store.getState().openCheckRunDetails('wt-1', 'repo:99', check, {
        details: null,
        loading: false,
        error: null
      })
      await store
        .getState()
        .reloadOpenCheckRunDetailsTab(
          remote
            ? 'wt-1::check-details@runtime:server::check-run:42'
            : 'wt-1::check-details::check-run:42'
        )

      expect(fetchPRCheckDetails).toHaveBeenCalledWith(
        repoPath,
        expect.objectContaining({ checkRunId: 42 }),
        { repoId: 'repo-1', repoOwnerExecutionHostId: executionHostId }
      )
    }
  )

  it('stops loading when an open check-details tab loses its repository', async () => {
    const fetchPRCheckDetails = vi.fn()
    const store = createEditorTabsStore()
    store.setState({
      activeWorktreeId: 'wt-1',
      repos: [],
      worktreesByRepo: {},
      fetchPRCheckDetails
    })
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

  // GitLab job refresh must use GitLab trace, not GitHub check-runs or the open tab blanks (#7732).
  it.each([
    'local',
    'runtime',
    'paired-ssh',
    'pinned-runtime',
    'pinned-local',
    'pinned-paired-ssh'
  ] as const)('reloads an open GitLab job tab through its %s owner', async (owner) => {
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
    const store = createEditorTabsStore()
    store.setState({
      activeWorktreeId: 'wt-1',
      repos: [{ ...TEST_REPO, id: 'repo-1', path: '/repo' }],
      worktreesByRepo: {
        'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo' })]
      },
      settings: null,
      fetchPRCheckDetails
    })
    if (owner !== 'local') {
      const local = store.getState().worktreesByRepo['repo-1'][0]
      store.setState({
        repos: [
          ...store.getState().repos,
          {
            ...store.getState().repos[0],
            path: '/remote',
            executionHostId: 'runtime:server',
            ...(owner.endsWith('paired-ssh') ? { connectionId: 'builder' } : {})
          }
        ],
        worktreesByRepo: {
          'repo-1': [
            ...(owner.startsWith('pinned-') ? [local] : []),
            {
              ...local,
              path: '/remote',
              hostId: owner.endsWith('paired-ssh') ? 'ssh:builder' : 'runtime:server',
              runtimeOwnerEnvironmentId: 'server'
            }
          ]
        }
      })
    }
    const check = {
      name: 'test: unit',
      status: 'completed' as const,
      conclusion: 'failure' as const,
      url: null,
      gitlabJobId: 42
    }

    if (owner.startsWith('pinned-')) {
      store.setState({
        activeWorkspaceExecutionHostId: owner === 'pinned-local' ? 'local' : 'runtime:server'
      })
    }

    store.getState().openCheckRunDetails('wt-1', 'repo:99', check, {
      details: null,
      loading: false,
      error: null
    })
    if (owner.startsWith('pinned-')) {
      store.setState({
        activeWorkspaceExecutionHostId: owner === 'pinned-local' ? 'runtime:server' : 'local'
      })
      store.getState().openCheckRunDetails('wt-1', 'repo:99', check, {
        details: null,
        loading: false,
        error: null
      })
    }

    // Reopening on the other host opens that host's own tab; the first tab keeps its owner.
    const ownerTabId = {
      local: 'wt-1::check-details::gitlab-job:42',
      runtime: 'wt-1::check-details@runtime:server::gitlab-job:42',
      'paired-ssh': 'wt-1::check-details@ssh:builder>runtime:server::gitlab-job:42',
      'pinned-runtime': 'wt-1::check-details@runtime:server::gitlab-job:42',
      'pinned-local': 'wt-1::check-details::gitlab-job:42',
      'pinned-paired-ssh': 'wt-1::check-details@runtime:server::gitlab-job:42'
    }[owner]
    expect(store.getState().openFiles.filter((file) => file.mode === 'check-details')).toHaveLength(
      owner.startsWith('pinned-') ? 2 : 1
    )
    await store.getState().reloadOpenCheckRunDetailsTab(ownerTabId)

    expect(fetchPRCheckDetails).not.toHaveBeenCalled()
    expect(loadGitLabJobLogDetailsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: owner === 'local' || owner === 'pinned-local' ? '/repo' : '/remote',
        repoId: 'repo-1',
        repoOwnerExecutionHostId:
          owner === 'local' || owner === 'pinned-local' ? 'local' : 'runtime:server',
        check
      })
    )
    expect(store.getState().openFiles).toContainEqual(
      expect.objectContaining({
        id: ownerTabId,
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

  it('refuses to reload an unqualified check tab when worktree owners conflict', async () => {
    loadGitLabJobLogDetailsMock.mockReset()
    const store = createEditorTabsStore()
    const local = store.getState().worktreesByRepo['repo-1'][0]
    store.setState({
      repos: [
        ...store.getState().repos,
        { ...store.getState().repos[0], executionHostId: 'runtime:server' }
      ],
      worktreesByRepo: {
        'repo-1': [
          local,
          { ...local, hostId: 'runtime:server', runtimeOwnerEnvironmentId: 'server' }
        ]
      }
    })
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

    expect(loadGitLabJobLogDetailsMock).not.toHaveBeenCalled()
    expect(store.getState().openFiles[0].checkRunDetails).toMatchObject({
      loading: false,
      error: 'Repository details are unavailable for this check.'
    })
  })

  // Fork MR job traces live in source project; retain stored project ref on reload (#7732).
  it('reloads a fork MR job tab with the stored GitLab project ref', async () => {
    loadGitLabJobLogDetailsMock.mockReset()
    loadGitLabJobLogDetailsMock.mockResolvedValue(null)
    const store = createEditorTabsStore()
    store.setState({
      activeWorktreeId: 'wt-1',
      repos: [{ ...TEST_REPO, id: 'repo-1', path: '/repo' }],
      worktreesByRepo: {
        'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo' })]
      },
      settings: null,
      fetchPRCheckDetails: vi.fn().mockResolvedValue(null)
    })
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
    const store = createEditorTabsStore()
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

  it('opens check full details as a center-pane editor tab', async () => {
    const store = createEditorTabsStore()
    const main = await drawTabsFromMain(store)
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
    // A layout-owner build draws the tab with main's frame, from the view its open sent.
    await main.settle()
    expect(store.getState().unifiedTabsByWorktree['wt-1']).toContainEqual(
      expect.objectContaining({
        entityId: 'wt-1::check-details::check-run:42',
        contentType: 'check-details',
        // Main's frame carries no label for a tab the window never drew.
        ...(ORCA_LAYOUT_OWNER_IS_MAIN ? {} : { label: 'verify' })
      })
    )
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      expect(layoutApplyTestTransport.sentOfType('openEditorTab')).toEqual([
        expect.objectContaining({
          contentType: 'check-details',
          view: expect.objectContaining({
            view: expect.objectContaining({ mode: 'check-details' })
          })
        })
      ])
    }
    main.close()
  })
})
