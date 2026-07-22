import { describe, expect, it } from 'vitest'
import type { WorktreeCreationRequest } from './pending-worktree-creation'
import { findPendingGitHubWorkItemCreate } from './github-work-item-background-match'

function request(
  agent: WorktreeCreationRequest['agent'],
  hostId: NonNullable<WorktreeCreationRequest['workspaceRunContext']>['hostId'] = 'local'
): WorktreeCreationRequest {
  return {
    repoId: 'repo-1',
    workspaceRunContext: {
      kind: 'workspace-run',
      projectId: 'repo-1',
      hostId,
      projectHostSetupId: `repo-1:${hostId}`,
      repoId: 'repo-1',
      path: '/repo'
    },
    name: 'issue-42',
    setupDecision: 'inherit',
    linkedIssue: 42,
    agent,
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null
  }
}

describe('findPendingGitHubWorkItemCreate', () => {
  const pending = {
    'creation-codex': {
      creationId: 'creation-codex',
      phase: 'preparing' as const,
      status: 'creating' as const,
      indeterminate: false,
      loaderVisible: true,
      startedAt: 1,
      request: request('codex')
    }
  }

  it('preserves default-click deduplication regardless of the resolved pending agent', () => {
    expect(findPendingGitHubWorkItemCreate(pending, request(null))).toBe('creation-codex')
  })

  it('does not substitute an existing pending workspace for an explicit agent', () => {
    expect(findPendingGitHubWorkItemCreate(pending, request('claude'))).toBeNull()
    expect(findPendingGitHubWorkItemCreate(pending, request('codex'))).toBe('creation-codex')
  })

  it('does not match the same repository id on another execution host', () => {
    expect(findPendingGitHubWorkItemCreate(pending, request('codex', 'ssh:server-b'))).toBeNull()
  })
})
