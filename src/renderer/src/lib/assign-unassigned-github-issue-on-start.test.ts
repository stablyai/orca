import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assignUnassignedGitHubIssueOnStart,
  assignUnassignedGitHubIssueOnStartFailureMessage,
  GITHUB_START_ASSIGNEE_ME,
  githubIssueHasAssignees,
  isGitHubIssueForStartAssignment,
  shouldAssignUnassignedGitHubIssueOnStart
} from './assign-unassigned-github-issue-on-start'

const unassignedIssue = {
  provider: 'github' as const,
  type: 'issue',
  number: 21047,
  url: 'https://github.com/stablyai/orca/issues/21047',
  assignees: []
}

describe('shouldAssignUnassignedGitHubIssueOnStart', () => {
  it('assigns an unassigned GitHub issue when the setting is on', () => {
    expect(
      shouldAssignUnassignedGitHubIssueOnStart({
        enabled: true,
        item: unassignedIssue
      })
    ).toBe(true)
  })

  it('does not assign when the setting is off', () => {
    expect(
      shouldAssignUnassignedGitHubIssueOnStart({
        enabled: false,
        item: unassignedIssue
      })
    ).toBe(false)
  })

  it('does not assign an already-assigned GitHub issue', () => {
    expect(
      shouldAssignUnassignedGitHubIssueOnStart({
        enabled: true,
        item: {
          ...unassignedIssue,
          assignees: [{ login: 'teammate' }]
        }
      })
    ).toBe(false)
    expect(githubIssueHasAssignees([{ login: 'teammate' }])).toBe(true)
  })

  it('does not assign when assignee data is missing', () => {
    expect(
      shouldAssignUnassignedGitHubIssueOnStart({
        enabled: true,
        item: { ...unassignedIssue, assignees: undefined }
      })
    ).toBe(false)
    expect(
      shouldAssignUnassignedGitHubIssueOnStart({
        enabled: true,
        item: {
          provider: 'github',
          type: 'issue',
          number: 21047,
          url: 'https://github.com/stablyai/orca/issues/21047'
        }
      })
    ).toBe(false)
  })

  it('does not assign pull requests, GitLab, Linear, or Jira items', () => {
    expect(
      isGitHubIssueForStartAssignment({
        ...unassignedIssue,
        type: 'pr',
        url: 'https://github.com/stablyai/orca/pull/1'
      })
    ).toBe(false)
    expect(
      shouldAssignUnassignedGitHubIssueOnStart({
        enabled: true,
        item: {
          provider: 'gitlab',
          type: 'issue',
          number: 12,
          url: 'https://gitlab.com/acme/repo/-/issues/12',
          assignees: []
        }
      })
    ).toBe(false)
    expect(
      shouldAssignUnassignedGitHubIssueOnStart({
        enabled: true,
        item: {
          type: 'issue',
          number: 0,
          url: 'https://linear.app/acme/issue/ENG-1',
          linearIdentifier: 'ENG-1',
          assignees: []
        }
      })
    ).toBe(false)
    expect(
      shouldAssignUnassignedGitHubIssueOnStart({
        enabled: true,
        item: {
          provider: 'jira',
          type: 'issue',
          number: 0,
          url: 'https://acme.atlassian.net/browse/OPS-9',
          jiraIdentifier: 'OPS-9',
          assignees: []
        }
      })
    ).toBe(false)
  })
})

describe('assignUnassignedGitHubIssueOnStart', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('adds the current user when starting an unassigned GitHub issue with the setting on', async () => {
    const addAssignees = vi.fn().mockResolvedValue(undefined)
    const patchWorkItem = vi.fn()
    const result = await assignUnassignedGitHubIssueOnStart(
      { enabled: true, item: unassignedIssue, repoId: 'repo-1' },
      {
        resolveCurrentUserLogin: async () => 'octocat',
        addAssignees,
        patchWorkItem
      }
    )

    expect(result).toBe('assigned')
    expect(addAssignees).toHaveBeenCalledWith({
      repoId: 'repo-1',
      number: 21047,
      logins: ['octocat'],
      sourceContext: undefined
    })
    expect(patchWorkItem).toHaveBeenCalledWith(
      'issue:21047',
      { assignees: [{ login: 'octocat', name: null, avatarUrl: '' }] },
      'repo-1',
      { sourceContext: undefined }
    )
  })

  it('does not assign an already-assigned GitHub issue', async () => {
    const addAssignees = vi.fn()
    const patchWorkItem = vi.fn()
    const result = await assignUnassignedGitHubIssueOnStart(
      {
        enabled: true,
        item: { ...unassignedIssue, assignees: [{ login: 'teammate' }] },
        repoId: 'repo-1'
      },
      { addAssignees, patchWorkItem }
    )

    expect(result).toBe('skipped')
    expect(addAssignees).not.toHaveBeenCalled()
    expect(patchWorkItem).not.toHaveBeenCalled()
  })

  it('does not assign when the setting is off', async () => {
    const addAssignees = vi.fn()
    const patchWorkItem = vi.fn()
    const result = await assignUnassignedGitHubIssueOnStart(
      { enabled: false, item: unassignedIssue, repoId: 'repo-1' },
      { addAssignees, patchWorkItem }
    )

    expect(result).toBe('skipped')
    expect(addAssignees).not.toHaveBeenCalled()
    expect(patchWorkItem).not.toHaveBeenCalled()
  })

  it('reports failure without throwing when the assign RPC throws', async () => {
    const onFailure = vi.fn()
    const patchWorkItem = vi.fn()
    const result = await assignUnassignedGitHubIssueOnStart(
      { enabled: true, item: unassignedIssue, repoId: 'repo-1' },
      {
        resolveCurrentUserLogin: async () => 'octocat',
        addAssignees: async () => {
          throw new Error('Resource not accessible by integration')
        },
        patchWorkItem,
        onFailure
      }
    )

    expect(result).toBe('failed')
    expect(onFailure).toHaveBeenCalledWith(assignUnassignedGitHubIssueOnStartFailureMessage())
    expect(patchWorkItem).not.toHaveBeenCalled()
  })

  it('forwards sourceContext to the assignee mutation', async () => {
    const addAssignees = vi.fn().mockResolvedValue(undefined)
    const patchWorkItem = vi.fn()
    const sourceContext = {
      kind: 'task-source' as const,
      provider: 'github' as const,
      projectId: 'repo-1',
      hostId: 'runtime:env-1' as const,
      repoId: 'repo-1'
    }

    await assignUnassignedGitHubIssueOnStart(
      { enabled: true, item: unassignedIssue, repoId: 'repo-1', sourceContext },
      {
        resolveCurrentUserLogin: async () => 'octocat',
        addAssignees,
        patchWorkItem
      }
    )

    expect(addAssignees).toHaveBeenCalledWith({
      repoId: 'repo-1',
      number: 21047,
      logins: ['octocat'],
      sourceContext
    })
    expect(patchWorkItem).toHaveBeenCalledWith(
      'issue:21047',
      { assignees: [{ login: 'octocat', name: null, avatarUrl: '' }] },
      'repo-1',
      { sourceContext }
    )
  })

  it('falls back to @me when the viewer login is unavailable', async () => {
    const addAssignees = vi.fn().mockResolvedValue(undefined)
    const patchWorkItem = vi.fn()
    await assignUnassignedGitHubIssueOnStart(
      { enabled: true, item: unassignedIssue, repoId: 'repo-1' },
      {
        resolveCurrentUserLogin: async () => null,
        addAssignees,
        patchWorkItem
      }
    )

    expect(addAssignees).toHaveBeenCalledWith(
      expect.objectContaining({ logins: [GITHUB_START_ASSIGNEE_ME] })
    )
    expect(patchWorkItem).not.toHaveBeenCalled()
  })

  it('assigns @me on a runtime host instead of the desktop viewer login', async () => {
    const addAssignees = vi.fn().mockResolvedValue(undefined)
    const patchWorkItem = vi.fn()
    const viewer = vi.fn().mockResolvedValue({ login: 'desktop-user' })
    const sourceContext = {
      kind: 'task-source' as const,
      provider: 'github' as const,
      projectId: 'repo-1',
      hostId: 'runtime:env-1' as const,
      repoId: 'repo-1'
    }
    vi.stubGlobal('window', { api: { gh: { viewer } } })

    await assignUnassignedGitHubIssueOnStart(
      { enabled: true, item: unassignedIssue, repoId: 'repo-1', sourceContext },
      { addAssignees, patchWorkItem }
    )

    expect(addAssignees).toHaveBeenCalledWith({
      repoId: 'repo-1',
      number: 21047,
      logins: [GITHUB_START_ASSIGNEE_ME],
      sourceContext
    })
    expect(patchWorkItem).not.toHaveBeenCalled()
    expect(viewer).not.toHaveBeenCalled()
  })
})
