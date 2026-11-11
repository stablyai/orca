import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../shared/work-items/task-source-context'
import { createUIStore } from './ui/ui-slice-test-harness'

const mocks = vi.hoisted(() => ({
  sendNotesToActiveAgentSession: vi.fn(),
  track: vi.fn(),
  toastMessage: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/lib/agent-session/messaging/terminal/active-agent-note-send', () => ({
  activeAgentNotesSendFailureMessage: (
    status: string,
    options: { explicitTarget?: boolean } = {}
  ) => (options.explicitTarget ? `selected:${status}` : status),
  sendNotesToActiveAgentSession: mocks.sendNotesToActiveAgentSession
}))

vi.mock('@/diagnostics/telemetry/telemetry', () => ({
  track: mocks.track
}))

vi.mock('sonner', () => ({
  toast: {
    message: mocks.toastMessage,
    success: mocks.toastSuccess,
    error: mocks.toastError
  }
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  mocks.sendNotesToActiveAgentSession.mockReset()
  mocks.sendNotesToActiveAgentSession.mockResolvedValue({ status: 'sent' })
  mocks.track.mockReset()
  mocks.toastMessage.mockReset()
  mocks.toastSuccess.mockReset()
  mocks.toastError.mockReset()
})

function makeGitHubWorkItem(overrides: Partial<GitHubWorkItem> = {}): GitHubWorkItem {
  return {
    id: 'pr-95',
    type: 'pr',
    number: 95,
    title: 'feat: add file upload command',
    state: 'open',
    url: 'https://github.com/acme/repo/pull/95',
    labels: [],
    updatedAt: '2026-05-20T00:00:00.000Z',
    author: 'octocat',
    repoId: 'repo-1',
    ...overrides
  }
}

describe('createUISlice settings navigation', () => {
  it('prefetches the restored default task source when provider settings drifted', () => {
    const store = createUIStore()
    const prefetchWorkItems = vi.fn()
    const prefetchLinearIssues = vi.fn()

    store.setState({
      repos: [
        {
          id: 'repo-1',
          path: '/repo',
          displayName: 'Repo',
          badgeColor: 'blue',
          addedAt: 1,
          kind: 'git'
        }
      ],
      settings: {
        ...getDefaultSettings('/tmp'),
        visibleTaskProviders: ['linear'],
        defaultTaskSource: 'github',
        defaultTaskViewPreset: 'all'
      },
      linearStatus: { connected: true, viewer: null },
      preflightStatus: {
        git: { installed: true },
        gh: { installed: true, authenticated: true },
        glab: { installed: false, authenticated: false }
      },
      prefetchWorkItems,
      prefetchLinearIssues
    })

    store.getState().openTaskPage()

    expect(prefetchWorkItems).toHaveBeenCalledWith(
      'repo-1',
      '/repo',
      expect.any(Number),
      'is:issue is:open',
      {
        sourceContext: {
          kind: 'task-source',
          provider: 'github',
          projectId: 'repo:repo-1',
          hostId: 'local',
          projectHostSetupId: 'repo-1',
          repoId: 'repo-1',
          providerIdentity: null,
          accountLabel: null
        }
      }
    )
    expect(prefetchLinearIssues).not.toHaveBeenCalled()
  })

  it('prefetches direct GitHub task opens with their source context', () => {
    const store = createUIStore()
    const prefetchWorkItems = vi.fn()
    const workItem = makeGitHubWorkItem()
    const sourceContext: TaskSourceContext = {
      kind: 'task-source',
      provider: 'github',
      projectId: 'project-1',
      hostId: 'ssh:devbox',
      projectHostSetupId: 'setup-1',
      repoId: 'repo-1',
      providerIdentity: { provider: 'github', owner: 'acme', repo: 'repo' }
    }

    store.setState({
      repos: [
        {
          id: 'repo-1',
          path: '/repo',
          displayName: 'Repo',
          badgeColor: 'blue',
          addedAt: 1,
          kind: 'git',
          executionHostId: 'ssh:devbox',
          connectionId: 'devbox'
        }
      ],
      projects: [
        {
          id: 'project-1',
          displayName: 'Repo',
          badgeColor: 'blue',
          providerIdentity: { provider: 'github', owner: 'acme', repo: 'repo' },
          sourceRepoIds: ['repo-1'],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      projectHostSetups: [
        {
          id: 'setup-1',
          projectId: 'project-1',
          hostId: 'ssh:devbox',
          repoId: 'repo-1',
          path: '/repo',
          displayName: 'Repo',
          setupState: 'ready',
          setupMethod: 'legacy-repo',
          createdAt: 1,
          updatedAt: 1
        }
      ],
      settings: {
        ...getDefaultSettings('/tmp'),
        visibleTaskProviders: ['github'],
        defaultTaskSource: 'github',
        defaultTaskViewPreset: 'all'
      },
      prefetchWorkItems
    })

    store.getState().openTaskPage({
      taskSource: 'github',
      preselectedRepoId: 'repo-1',
      openGitHubWorkItem: workItem,
      openGitHubSourceContext: sourceContext
    })

    expect(prefetchWorkItems).toHaveBeenCalledWith(
      'repo-1',
      '/repo',
      expect.any(Number),
      'is:issue is:open',
      { sourceContext }
    )
    const exactRepo = store.getState().repos[0]!
    for (const repos of [
      [],
      [{ ...exactRepo, executionHostId: 'local' as const, connectionId: null }]
    ]) {
      prefetchWorkItems.mockClear()
      store.setState({ repos })
      store.getState().openTaskPage({
        taskSource: 'github',
        preselectedRepoId: 'repo-1',
        openGitHubWorkItem: workItem,
        openGitHubSourceContext: sourceContext
      })
      expect(prefetchWorkItems).not.toHaveBeenCalled()
    }
  })
})
