import { describe, expect, it } from 'vitest'
import {
  findPendingLinkedWorkItemCreationId,
  type PendingWorktreeCreation,
  type WorktreeCreationRequest
} from './pending-worktree-creation'

function request(overrides: Partial<WorktreeCreationRequest> = {}): WorktreeCreationRequest {
  return {
    repoId: 'repo-1',
    name: 'workspace',
    setupDecision: 'inherit',
    agent: null,
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null,
    ...overrides
  }
}

function pending(
  creationId: string,
  creationRequest: WorktreeCreationRequest
): PendingWorktreeCreation {
  return {
    creationId,
    phase: 'preparing',
    status: 'creating',
    startedAt: 1,
    indeterminate: false,
    loaderVisible: true,
    request: creationRequest
  }
}

describe('findPendingLinkedWorkItemCreationId', () => {
  it('deduplicates the same linked item on the same execution host', () => {
    const existing = request({
      linkedIssue: 42,
      workspaceRunContext: {
        kind: 'workspace-run',
        projectId: 'project-1',
        hostId: 'ssh:server',
        projectHostSetupId: 'setup-1',
        repoId: 'repo-1',
        path: '/repo'
      }
    })

    expect(
      findPendingLinkedWorkItemCreationId(
        { existing: pending('existing', existing) },
        request({
          linkedIssue: 42,
          workspaceRunContext: {
            ...existing.workspaceRunContext!,
            path: '/renamed-repo'
          }
        })
      )
    ).toBe('existing')
  })

  it('keeps the same linked item on different execution hosts distinct', () => {
    const existing = request({
      linkedPR: 77,
      workspaceRunContext: {
        kind: 'workspace-run',
        projectId: 'project-1',
        hostId: 'ssh:server-a',
        projectHostSetupId: 'setup-a',
        repoId: 'repo-1',
        path: '/repo'
      }
    })

    expect(
      findPendingLinkedWorkItemCreationId(
        { existing: pending('existing', existing) },
        request({
          linkedPR: 77,
          workspaceRunContext: {
            ...existing.workspaceRunContext!,
            hostId: 'ssh:server-b',
            projectHostSetupId: 'setup-b'
          }
        })
      )
    ).toBeNull()
  })

  it('does not deduplicate unlinked workspace creation', () => {
    expect(
      findPendingLinkedWorkItemCreationId({ existing: pending('existing', request()) }, request())
    ).toBeNull()
  })
})
