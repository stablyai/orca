import { describe, expect, it } from 'vitest'
import {
  findPendingLinkedWorkItemCreationId,
  findPendingWorktreeCreationId,
  type PendingWorktreeCreation,
  usesAgentLaunchList,
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

describe('findPendingWorktreeCreationId', () => {
  it('matches Windows path spelling while keeping repositories distinct', () => {
    const entry = {
      ...pending('create-1', request()),
      worktreeId: 'repo-1::C:\\workspaces\\feature'
    }
    expect(findPendingWorktreeCreationId({ entry }, 'repo-1::c:/workspaces/feature/')).toBe(
      'create-1'
    )
    expect(findPendingWorktreeCreationId({ entry }, 'repo-2::c:/workspaces/feature/')).toBeNull()
  })
})

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
})

describe('usesAgentLaunchList', () => {
  it('keeps requests without a launch list on the legacy path', () => {
    expect(usesAgentLaunchList({ agent: 'codex' })).toBe(false)
    expect(usesAgentLaunchList({ agent: null })).toBe(false)
  })

  it('keeps a single bare entry on the legacy path', () => {
    expect(usesAgentLaunchList({ agent: null, agentLaunches: [{ agent: 'codex' }] })).toBe(false)
  })

  it('switches to the list when a second row exists', () => {
    expect(
      usesAgentLaunchList({
        agent: null,
        agentLaunches: [{ agent: 'codex' }, { agent: 'codex' }]
      })
    ).toBe(true)
  })

  it('switches to the list for a single entry with CLI args', () => {
    expect(
      usesAgentLaunchList({
        agent: null,
        agentLaunches: [{ agent: 'codex', agentArgs: '--profile fast' }]
      })
    ).toBe(true)
  })

  it('switches to the list for a single entry with a custom name', () => {
    expect(
      usesAgentLaunchList({
        agent: null,
        agentLaunches: [{ agent: 'codex', displayName: 'worker' }]
      })
    ).toBe(true)
  })

  it('switches to the list for a single entry with session options', () => {
    expect(
      usesAgentLaunchList({
        agent: null,
        agentLaunches: [{ agent: 'codex', sessionOptions: { model: 'x' } }]
      })
    ).toBe(true)
  })

  it('does not switch for a surface choice alone or blank entry values', () => {
    expect(
      usesAgentLaunchList({
        agent: null,
        agentLaunches: [{ agent: 'codex', requestedSurface: 'chat' }]
      })
    ).toBe(false)
    expect(
      usesAgentLaunchList({
        agent: null,
        agentLaunches: [{ agent: 'codex', agentArgs: '  ', displayName: '', sessionOptions: {} }]
      })
    ).toBe(false)
  })

  it('round-trips agentLaunches through JSON', () => {
    const launches = [
      {
        agent: 'codex' as const,
        agentArgs: '--profile fast',
        sessionOptions: { model: 'gpt-5' },
        sessionOptionsYieldToAgentArgs: true as const,
        requestedSurface: 'terminal' as const,
        displayName: 'worker'
      },
      { agent: 'claude' as const, displayName: 'reviewer' }
    ]
    const full = request({ agentLaunches: launches })

    expect(JSON.parse(JSON.stringify(full)).agentLaunches).toEqual(launches)
  })
})
