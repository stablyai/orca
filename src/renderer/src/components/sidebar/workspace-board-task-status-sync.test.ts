import { describe, expect, it, vi } from 'vitest'
import type {
  LinearIssue,
  LinearWorkflowState,
  WorkspaceStatusDefinition,
  Worktree
} from '../../../../shared/types'
import type { LinearMutationResult } from '@/runtime/runtime-linear-client'
import {
  getWorkspaceBoardTaskStatusSyncRequest,
  syncWorkspaceBoardTaskStatuses
} from './workspace-board-task-status-sync'

function issue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'issue-1',
    identifier: 'ORC-1',
    title: 'Sync the board',
    description: '',
    url: 'https://linear.app/orca/issue/ORC-1/sync-the-board',
    state: { name: 'Todo', type: 'unstarted', color: '#999' },
    team: { id: 'team-1', name: 'Orca', key: 'ORC' },
    labels: [],
    labelIds: [],
    priority: 0,
    updatedAt: '2026-06-15T00:00:00.000Z',
    ...overrides
  }
}

function state(overrides: Partial<LinearWorkflowState> = {}): LinearWorkflowState {
  return {
    id: 'state-review',
    name: 'In review',
    type: 'started',
    color: '#111',
    position: 1,
    ...overrides
  }
}

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo::/worktree',
    linkedLinearIssue: 'ORC-1',
    linkedLinearIssueWorkspaceId: 'workspace-1',
    ...overrides
  } as Worktree
}

function targetStatus(
  overrides: Partial<WorkspaceStatusDefinition> = {}
): WorkspaceStatusDefinition {
  return { id: 'in-review', label: 'In review', ...overrides }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks(count = 5): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve()
  }
}

function setup(overrides: Partial<Worktree> = {}) {
  const target = targetStatus()
  const item = worktree(overrides)
  const getIssue = vi.fn().mockResolvedValue(issue())
  const teamStates = vi.fn().mockResolvedValue([state()])
  const updateIssue = vi.fn<() => Promise<LinearMutationResult>>().mockResolvedValue({ ok: true })

  return {
    item,
    target,
    getIssue,
    teamStates,
    updateIssue,
    run: () =>
      syncWorkspaceBoardTaskStatuses({
        worktreeIds: [item.id],
        targetStatus: target,
        worktreesById: new Map([[item.id, item]]),
        settings: { activeRuntimeEnvironmentId: 'runtime-1' },
        getLatestWorkspaceStatus: () => target.id,
        deps: { getIssue, teamStates, updateIssue }
      })
  }
}

describe('syncWorkspaceBoardTaskStatuses', () => {
  it('updates Linear when exactly one workflow state matches the board status', async () => {
    const { run, getIssue, teamStates, updateIssue } = setup()

    await expect(run()).resolves.toEqual({ updated: 1, skipped: 0, failed: 0, messages: [] })

    expect(getIssue).toHaveBeenCalledWith(
      { activeRuntimeEnvironmentId: 'runtime-1' },
      'ORC-1',
      'workspace-1'
    )
    expect(teamStates).toHaveBeenCalledWith(
      { activeRuntimeEnvironmentId: 'runtime-1' },
      'team-1',
      'workspace-1'
    )
    expect(updateIssue).toHaveBeenCalledWith(
      { activeRuntimeEnvironmentId: 'runtime-1' },
      'issue-1',
      { stateId: 'state-review' },
      'workspace-1'
    )
  })

  it('uses the fetched issue workspace for state reads and writes when the link lacks one', async () => {
    const { item, target, getIssue, teamStates, updateIssue } = setup({
      linkedLinearIssueWorkspaceId: null
    })
    getIssue.mockResolvedValueOnce(issue({ workspaceId: 'issue-workspace' }))

    await syncWorkspaceBoardTaskStatuses({
      worktreeIds: [item.id],
      targetStatus: target,
      worktreesById: new Map([[item.id, item]]),
      settings: null,
      getLatestWorkspaceStatus: () => target.id,
      deps: { getIssue, teamStates, updateIssue }
    })

    expect(getIssue).toHaveBeenCalledWith(null, 'ORC-1', undefined)
    expect(teamStates).toHaveBeenCalledWith(null, 'team-1', 'issue-workspace')
    expect(updateIssue).toHaveBeenCalledWith(
      null,
      'issue-1',
      { stateId: 'state-review' },
      'issue-workspace'
    )
  })

  it('routes each Linear update through the moved worktree owner settings', async () => {
    const target = targetStatus()
    const first = worktree({ id: 'repo-a::/worktree-a', linkedLinearIssue: 'ORC-1' })
    const second = worktree({ id: 'repo-b::/worktree-b', linkedLinearIssue: 'ORC-2' })
    const getIssue = vi
      .fn()
      .mockResolvedValueOnce(issue({ id: 'issue-1', identifier: 'ORC-1' }))
      .mockResolvedValueOnce(issue({ id: 'issue-2', identifier: 'ORC-2' }))
    const teamStates = vi.fn().mockResolvedValue([state()])
    const updateIssue = vi.fn<() => Promise<LinearMutationResult>>().mockResolvedValue({ ok: true })
    const getSettingsForWorktree = vi.fn((worktreeId: string) => ({
      activeRuntimeEnvironmentId: worktreeId.startsWith('repo-a') ? 'runtime-a' : 'runtime-b'
    }))

    await syncWorkspaceBoardTaskStatuses({
      worktreeIds: [first.id, second.id],
      targetStatus: target,
      worktreesById: new Map([
        [first.id, first],
        [second.id, second]
      ]),
      settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
      getSettingsForWorktree,
      getLatestWorkspaceStatus: () => target.id,
      deps: { getIssue, teamStates, updateIssue }
    })

    expect(getSettingsForWorktree).toHaveBeenCalledWith(first.id)
    expect(getSettingsForWorktree).toHaveBeenCalledWith(second.id)
    expect(getIssue).toHaveBeenNthCalledWith(
      1,
      { activeRuntimeEnvironmentId: 'runtime-a' },
      'ORC-1',
      'workspace-1'
    )
    expect(getIssue).toHaveBeenNthCalledWith(
      2,
      { activeRuntimeEnvironmentId: 'runtime-b' },
      'ORC-2',
      'workspace-1'
    )
    expect(updateIssue).toHaveBeenNthCalledWith(
      1,
      { activeRuntimeEnvironmentId: 'runtime-a' },
      'issue-1',
      { stateId: 'state-review' },
      'workspace-1'
    )
    expect(updateIssue).toHaveBeenNthCalledWith(
      2,
      { activeRuntimeEnvironmentId: 'runtime-b' },
      'issue-2',
      { stateId: 'state-review' },
      'workspace-1'
    )
  })

  it('preserves null settings from the moved worktree resolver', async () => {
    const { item, target, getIssue, teamStates, updateIssue } = setup()
    const getSettingsForWorktree = vi.fn(() => null)

    await syncWorkspaceBoardTaskStatuses({
      worktreeIds: [item.id],
      targetStatus: target,
      worktreesById: new Map([[item.id, item]]),
      settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
      getSettingsForWorktree,
      getLatestWorkspaceStatus: () => target.id,
      deps: { getIssue, teamStates, updateIssue }
    })

    expect(getSettingsForWorktree).toHaveBeenCalledWith(item.id)
    expect(getIssue).toHaveBeenCalledWith(null, 'ORC-1', 'workspace-1')
    expect(teamStates).toHaveBeenCalledWith(null, 'team-1', 'workspace-1')
    expect(updateIssue).toHaveBeenCalledWith(
      null,
      'issue-1',
      { stateId: 'state-review' },
      'workspace-1'
    )
  })

  it('skips worktrees without linked Linear issues', async () => {
    const { item, target, getIssue, teamStates, updateIssue } = setup({ linkedLinearIssue: null })

    const result = await syncWorkspaceBoardTaskStatuses({
      worktreeIds: [item.id],
      targetStatus: target,
      worktreesById: new Map([[item.id, item]]),
      settings: null,
      getLatestWorkspaceStatus: () => target.id,
      deps: { getIssue, teamStates, updateIssue }
    })

    expect(result).toEqual({ updated: 0, skipped: 1, failed: 0, messages: [] })
    expect(getIssue).not.toHaveBeenCalled()
    expect(teamStates).not.toHaveBeenCalled()
    expect(updateIssue).not.toHaveBeenCalled()
  })

  it('skips when the Linear issue is already in the matching state', async () => {
    const { run, getIssue, updateIssue } = setup()
    getIssue.mockResolvedValueOnce(
      issue({ state: { name: 'In review', type: 'started', color: '#111' } })
    )

    await expect(run()).resolves.toEqual({ updated: 0, skipped: 1, failed: 0, messages: [] })

    expect(updateIssue).not.toHaveBeenCalled()
  })

  it('skips missing or ambiguous workflow state matches', async () => {
    const missing = setup()
    missing.teamStates.mockResolvedValueOnce([state({ name: 'Done' })])

    await expect(missing.run()).resolves.toMatchObject({
      updated: 0,
      skipped: 1,
      failed: 0,
      messages: [{ kind: 'missing-workflow-state', statusLabel: 'In review' }]
    })
    expect(missing.updateIssue).not.toHaveBeenCalled()

    const ambiguous = setup()
    ambiguous.teamStates.mockResolvedValueOnce([
      state({ id: 'state-1', name: 'In review' }),
      state({ id: 'state-2', name: ' in REVIEW ' })
    ])

    await expect(ambiguous.run()).resolves.toMatchObject({
      updated: 0,
      skipped: 1,
      failed: 0,
      messages: [{ kind: 'ambiguous-workflow-state', statusLabel: 'In review' }]
    })
    expect(ambiguous.updateIssue).not.toHaveBeenCalled()
  })

  it('skips stale async writes when the local workspace status changed again', async () => {
    const { item, target, getIssue, teamStates, updateIssue } = setup()

    const result = await syncWorkspaceBoardTaskStatuses({
      worktreeIds: [item.id],
      targetStatus: target,
      worktreesById: new Map([[item.id, item]]),
      settings: null,
      getLatestWorkspaceStatus: () => 'done',
      deps: { getIssue, teamStates, updateIssue }
    })

    expect(result).toEqual({ updated: 0, skipped: 1, failed: 0, messages: [] })
    expect(updateIssue).not.toHaveBeenCalled()
  })

  it('serializes repeated moves for the same worktree so the latest status wins', async () => {
    const item = worktree()
    const firstUpdate = deferred<LinearMutationResult>()
    const getIssue = vi.fn().mockResolvedValue(issue())
    const teamStates = vi
      .fn()
      .mockResolvedValueOnce([state()])
      .mockResolvedValueOnce([state({ id: 'state-done', name: 'Done', type: 'completed' })])
    const updateIssue = vi
      .fn<() => Promise<LinearMutationResult>>()
      .mockReturnValueOnce(firstUpdate.promise)
      .mockResolvedValueOnce({ ok: true })

    const firstSync = syncWorkspaceBoardTaskStatuses({
      worktreeIds: [item.id],
      targetStatus: targetStatus(),
      worktreesById: new Map([[item.id, item]]),
      settings: null,
      getLatestWorkspaceStatus: () => 'in-review',
      deps: { getIssue, teamStates, updateIssue }
    })
    await flushMicrotasks()
    expect(updateIssue).toHaveBeenCalledTimes(1)

    const secondSync = syncWorkspaceBoardTaskStatuses({
      worktreeIds: [item.id],
      targetStatus: targetStatus({ id: 'done', label: 'Done' }),
      worktreesById: new Map([[item.id, item]]),
      settings: null,
      getLatestWorkspaceStatus: () => 'done',
      deps: { getIssue, teamStates, updateIssue }
    })
    await flushMicrotasks()
    expect(updateIssue).toHaveBeenCalledTimes(1)

    firstUpdate.resolve({ ok: true })
    await firstSync
    await secondSync

    expect(updateIssue).toHaveBeenNthCalledWith(
      1,
      null,
      'issue-1',
      { stateId: 'state-review' },
      'workspace-1'
    )
    expect(updateIssue).toHaveBeenNthCalledWith(
      2,
      null,
      'issue-1',
      { stateId: 'state-done' },
      'workspace-1'
    )
  })

  it('aggregates provider write failures without throwing', async () => {
    const { run, updateIssue } = setup()
    updateIssue.mockResolvedValueOnce({ ok: false, error: 'Linear is unavailable' })

    await expect(run()).resolves.toEqual({
      updated: 0,
      skipped: 0,
      failed: 1,
      messages: [
        {
          kind: 'update-failed',
          issueIdentifier: 'ORC-1',
          detail: 'Linear is unavailable'
        }
      ]
    })
  })
})

describe('getWorkspaceBoardTaskStatusSyncRequest', () => {
  const workspaceStatuses: WorkspaceStatusDefinition[] = [
    { id: 'todo', label: 'Todo' },
    { id: 'in-review', label: 'In review' }
  ]

  it('builds a sync request for enabled status moves', () => {
    const request = getWorkspaceBoardTaskStatusSyncRequest({
      enabled: true,
      worktreeIds: ['repo::/a'],
      status: 'in-review',
      worktreesById: new Map([['repo::/a', worktree({ workspaceStatus: 'todo' })]]),
      workspaceStatuses
    })

    expect(request).toEqual({
      worktreeIds: ['repo::/a'],
      targetStatus: { id: 'in-review', label: 'In review' }
    })
  })

  it('does not build a sync request while the board setting is disabled', () => {
    expect(
      getWorkspaceBoardTaskStatusSyncRequest({
        enabled: false,
        worktreeIds: ['repo::/a'],
        status: 'in-review',
        worktreesById: new Map([['repo::/a', worktree({ workspaceStatus: 'todo' })]]),
        workspaceStatuses
      })
    ).toBeNull()
  })

  it('skips same-status and duplicate ids so manual-order-only drops do not sync', () => {
    expect(
      getWorkspaceBoardTaskStatusSyncRequest({
        enabled: true,
        worktreeIds: ['repo::/a', 'repo::/a'],
        status: 'in-review',
        worktreesById: new Map([['repo::/a', worktree({ workspaceStatus: 'in-review' })]]),
        workspaceStatuses
      })
    ).toBeNull()
  })

  it('does not build a sync request without a board status target', () => {
    expect(
      getWorkspaceBoardTaskStatusSyncRequest({
        enabled: true,
        worktreeIds: ['repo::/a'],
        status: 'unknown-status',
        worktreesById: new Map([['repo::/a', worktree({ workspaceStatus: 'todo' })]]),
        workspaceStatuses
      })
    ).toBeNull()
  })
})
