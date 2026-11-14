import { describe, expect, it, vi } from 'vitest'
import type { LinearIssue } from '../../../../../../shared/linear/issue-types'
import type { LinearWorkflowState } from '../../../../../../shared/linear/workspace-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import type { LinearMutationResult } from '@/runtime/linear/runtime-linear-client'
import { syncWorkspaceBoardTaskStatuses } from './workspace-board-task-status-sync'

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
        worktreeKeys: [item.id],
        targetStatus: target,
        worktreesByKey: new Map([[item.id, item]]),
        settings: { kind: 'environment', environmentId: 'runtime-1' },
        getLatestWorkspaceStatus: () => target.id,
        deps: { getIssue, teamStates, updateIssue }
      })
  }
}

describe('syncWorkspaceBoardTaskStatuses', () => {
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
      worktreeKeys: [item.id],
      targetStatus: targetStatus(),
      worktreesByKey: new Map([[item.id, item]]),
      settings: { kind: 'local' },
      getLatestWorkspaceStatus: () => 'in-review',
      deps: { getIssue, teamStates, updateIssue }
    })
    await flushMicrotasks()
    expect(updateIssue).toHaveBeenCalledTimes(1)

    const secondSync = syncWorkspaceBoardTaskStatuses({
      worktreeKeys: [item.id],
      targetStatus: targetStatus({ id: 'done', label: 'Done' }),
      worktreesByKey: new Map([[item.id, item]]),
      settings: { kind: 'local' },
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
      { kind: 'local' },
      'issue-1',
      { stateId: 'state-review' },
      'workspace-1'
    )
    expect(updateIssue).toHaveBeenNthCalledWith(
      2,
      { kind: 'local' },
      'issue-1',
      { stateId: 'state-done' },
      'workspace-1'
    )
  })
})
