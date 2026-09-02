import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUIStore } from './ui-slice-test-harness'

const mocks = vi.hoisted(() => ({
  sendNotesToActiveAgentSession: vi.fn(),
  track: vi.fn(),
  toastMessage: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/lib/active-agent-note-send', () => ({
  activeAgentNotesSendFailureMessage: (
    status: string,
    options: { explicitTarget?: boolean } = {}
  ) => (options.explicitTarget ? `selected:${status}` : status),
  sendNotesToActiveAgentSession: mocks.sendNotesToActiveAgentSession
}))

vi.mock('@/lib/telemetry', () => ({
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

describe('createUISlice new workspace draft', () => {
  it('preserves Linear linked work item metadata', () => {
    const store = createUIStore()

    store.getState().setNewWorkspaceDraft({
      repoId: 'repo-1',
      name: 'Fix launch context handoff',
      prompt: '',
      note: '',
      attachments: [],
      linkedWorkItem: {
        type: 'issue',
        number: 0,
        title: 'Fix launch context handoff',
        url: 'https://linear.app/acme/issue/ENG-123/fix-launch-context-handoff',
        linearIdentifier: 'ENG-123'
      },
      agent: 'claude',
      linkedIssue: '',
      linkedPR: null,
      linkedGitLabIssue: null,
      linkedGitLabMR: null
    })

    expect(store.getState().newWorkspaceDraft?.linkedWorkItem).toMatchObject({
      linearIdentifier: 'ENG-123'
    })
  })

  it('keeps older linked work item drafts without Linear context fields valid', () => {
    const store = createUIStore()

    store.getState().setNewWorkspaceDraft({
      repoId: 'repo-1',
      name: 'Legacy issue',
      prompt: '',
      note: '',
      attachments: [],
      linkedWorkItem: {
        type: 'issue',
        number: 42,
        title: 'Legacy issue',
        url: 'https://github.com/acme/repo/issues/42'
      },
      agent: 'claude',
      linkedIssue: '42',
      linkedPR: null,
      linkedGitLabIssue: null,
      linkedGitLabMR: null
    })

    expect(store.getState().newWorkspaceDraft?.linkedWorkItem).toEqual({
      type: 'issue',
      number: 42,
      title: 'Legacy issue',
      url: 'https://github.com/acme/repo/issues/42'
    })
  })

  it('preserves serializable Jira identity and bound source context in drafts', () => {
    const store = createUIStore()
    const linkedTaskSourceContext = {
      kind: 'task-source' as const,
      provider: 'jira' as const,
      projectId: 'project-1',
      hostId: 'runtime:env-1' as const,
      providerIdentity: {
        provider: 'jira' as const,
        siteId: 'site-1',
        siteUrl: 'https://company.atlassian.net',
        projectKey: 'ORCA'
      },
      accountLabel: 'ada@example.com'
    }

    store.getState().setNewWorkspaceDraft({
      repoId: 'repo-1',
      name: 'orca-123-link-jira',
      prompt: '',
      note: '',
      attachments: [],
      linkedWorkItem: {
        provider: 'jira',
        type: 'issue',
        number: 0,
        title: 'ORCA-123 Link Jira',
        url: 'https://company.atlassian.net/browse/ORCA-123',
        jiraIdentifier: 'ORCA-123'
      },
      linkedTaskSourceContext,
      agent: 'claude',
      linkedIssue: '',
      linkedPR: null,
      linkedGitLabIssue: null,
      linkedGitLabMR: null
    })

    expect(store.getState().newWorkspaceDraft).toMatchObject({
      linkedWorkItem: {
        provider: 'jira',
        jiraIdentifier: 'ORCA-123'
      },
      linkedTaskSourceContext
    })
  })
})
