import { describe, expect, it, vi } from 'vitest'
import type {
  JiraIssue,
  JiraTransition,
  LinearIssue,
  LinearWorkflowState,
  Repo,
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
    repoId: 'repo',
    linkedLinearIssue: 'ORC-1',
    linkedLinearIssueWorkspaceId: 'workspace-1',
    linkedIssue: null,
    linkedPR: null,
    ...overrides
  } as Worktree
}

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#999',
    addedAt: 1,
    ...overrides
  } as Repo
}

function jiraIssue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: 'jira-1',
    key: 'STA-776',
    title: 'Sync Jira',
    url: 'https://example.atlassian.net/browse/STA-776',
    project: { id: 'project-1', key: 'STA', name: 'Status App' },
    issueType: { id: 'type-1', name: 'Task' },
    status: { id: 'todo', name: 'Todo', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    updatedAt: '2026-06-15T00:00:00.000Z',
    createdAt: '2026-06-15T00:00:00.000Z',
    ...overrides
  }
}

function jiraTransition(overrides: Partial<JiraTransition> = {}): JiraTransition {
  return {
    id: 'transition-review',
    name: 'In review',
    to: {
      id: 'in-review',
      name: 'In review',
      categoryKey: 'indeterminate',
      categoryName: 'In Progress'
    },
    ...overrides
  }
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
      messages: [
        { kind: 'missing-provider-status-mapping', provider: 'Linear', statusLabel: 'In review' }
      ]
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
      messages: [
        { kind: 'ambiguous-provider-status-mapping', provider: 'Linear', statusLabel: 'In review' }
      ]
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

  it('routes GitHub linked issues through repo context and moved worktree settings', async () => {
    const target = targetStatus({ id: 'done', label: 'Done' })
    const item = worktree({
      linkedLinearIssue: null,
      linkedIssue: 42,
      linkedIssueSourcePreference: 'origin',
      linkedPR: null
    })
    const updateGitHubIssue = vi.fn().mockResolvedValue({ ok: true })
    const getSettingsForWorktree = vi.fn(() => ({ activeRuntimeEnvironmentId: 'runtime-owner' }))

    await expect(
      syncWorkspaceBoardTaskStatuses({
        worktreeIds: [item.id],
        targetStatus: target,
        worktreesById: new Map([[item.id, item]]),
        repoById: new Map([
          [
            item.repoId,
            repo({ id: item.repoId, path: '/repo-root', issueSourcePreference: 'upstream' })
          ]
        ]),
        settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
        getSettingsForWorktree,
        getLatestWorkspaceStatus: () => target.id,
        deps: { updateGitHubIssue }
      })
    ).resolves.toEqual({ updated: 1, skipped: 0, failed: 0, messages: [] })

    expect(updateGitHubIssue).toHaveBeenCalledWith(
      { activeRuntimeEnvironmentId: 'runtime-owner' },
      {
        repoPath: '/repo-root',
        repoId: item.repoId,
        issueSourcePreference: 'origin',
        number: 42,
        updates: { state: 'closed' }
      }
    )
  })

  it('falls back to repo GitHub issue source when worktree metadata has no source', async () => {
    const target = targetStatus({ id: 'done', label: 'Done' })
    const item = worktree({
      linkedLinearIssue: null,
      linkedIssue: 42,
      linkedIssueSourcePreference: null,
      linkedPR: null
    })
    const updateGitHubIssue = vi.fn().mockResolvedValue({ ok: true })

    await expect(
      syncWorkspaceBoardTaskStatuses({
        worktreeIds: [item.id],
        targetStatus: target,
        worktreesById: new Map([[item.id, item]]),
        repoById: new Map([
          [
            item.repoId,
            repo({ id: item.repoId, path: '/repo-root', issueSourcePreference: 'origin' })
          ]
        ]),
        getLatestWorkspaceStatus: () => target.id,
        deps: { updateGitHubIssue }
      })
    ).resolves.toEqual({ updated: 1, skipped: 0, failed: 0, messages: [] })

    expect(updateGitHubIssue).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ issueSourcePreference: 'origin' })
    )
  })

  it('skips GitHub pull request links without calling issue update', async () => {
    const target = targetStatus({ id: 'done', label: 'Done' })
    const item = worktree({ linkedLinearIssue: null, linkedIssue: 42, linkedPR: 42 })
    const updateGitHubIssue = vi.fn()

    const result = await syncWorkspaceBoardTaskStatuses({
      worktreeIds: [item.id],
      targetStatus: target,
      worktreesById: new Map([[item.id, item]]),
      repoById: new Map([[item.repoId, repo({ id: item.repoId })]]),
      getLatestWorkspaceStatus: () => target.id,
      deps: { updateGitHubIssue }
    })

    expect(result).toEqual({
      updated: 0,
      skipped: 1,
      failed: 0,
      messages: [{ kind: 'unsupported-linked-item-kind', provider: 'GitHub', issueNumber: 42 }]
    })
    expect(updateGitHubIssue).not.toHaveBeenCalled()
  })

  it('skips repo-backed issue links when repo context is missing', async () => {
    const target = targetStatus({ id: 'done', label: 'Done' })
    const github = worktree({ id: 'repo::/github', linkedLinearIssue: null, linkedIssue: 4 })
    const gitlab = worktree({
      id: 'repo::/gitlab',
      linkedLinearIssue: null,
      linkedGitLabIssue: 5
    })
    const updateGitHubIssue = vi.fn()
    const updateGitLabIssue = vi.fn()

    const result = await syncWorkspaceBoardTaskStatuses({
      worktreeIds: [github.id, gitlab.id],
      targetStatus: target,
      worktreesById: new Map([
        [github.id, github],
        [gitlab.id, gitlab]
      ]),
      getLatestWorkspaceStatus: () => target.id,
      deps: { updateGitHubIssue, updateGitLabIssue }
    })

    expect(result).toMatchObject({
      updated: 0,
      skipped: 2,
      failed: 0,
      messages: [
        { kind: 'repo-context-missing', provider: 'GitHub', issueNumber: 4 },
        { kind: 'repo-context-missing', provider: 'GitLab', issueNumber: 5 }
      ]
    })
    expect(updateGitHubIssue).not.toHaveBeenCalled()
    expect(updateGitLabIssue).not.toHaveBeenCalled()
  })

  it('skips GitHub and GitLab statuses that do not map to provider states', async () => {
    const target = targetStatus({ id: 'blocked', label: 'Blocked' })
    const github = worktree({ id: 'repo::/github', linkedLinearIssue: null, linkedIssue: 4 })
    const gitlab = worktree({
      id: 'repo::/gitlab',
      linkedLinearIssue: null,
      linkedGitLabIssue: 5
    })
    const updateGitHubIssue = vi.fn()
    const updateGitLabIssue = vi.fn()

    const result = await syncWorkspaceBoardTaskStatuses({
      worktreeIds: [github.id, gitlab.id],
      targetStatus: target,
      worktreesById: new Map([
        [github.id, github],
        [gitlab.id, gitlab]
      ]),
      repoById: new Map([[repo().id, repo()]]),
      getLatestWorkspaceStatus: () => target.id,
      deps: { updateGitHubIssue, updateGitLabIssue }
    })

    expect(result).toMatchObject({
      updated: 0,
      skipped: 2,
      failed: 0,
      messages: [
        { kind: 'missing-provider-status-mapping', provider: 'GitHub', statusLabel: 'Blocked' },
        { kind: 'missing-provider-status-mapping', provider: 'GitLab', statusLabel: 'Blocked' }
      ]
    })
    expect(updateGitHubIssue).not.toHaveBeenCalled()
    expect(updateGitLabIssue).not.toHaveBeenCalled()
  })

  it('protects GitHub updates from stale local status after mapping', async () => {
    const target = targetStatus({ id: 'done', label: 'Done' })
    const item = worktree({ linkedLinearIssue: null, linkedIssue: 42 })
    const updateGitHubIssue = vi.fn()

    const result = await syncWorkspaceBoardTaskStatuses({
      worktreeIds: [item.id],
      targetStatus: target,
      worktreesById: new Map([[item.id, item]]),
      repoById: new Map([[item.repoId, repo({ id: item.repoId })]]),
      getLatestWorkspaceStatus: () => 'in-review',
      deps: { updateGitHubIssue }
    })

    expect(result).toEqual({ updated: 0, skipped: 1, failed: 0, messages: [] })
    expect(updateGitHubIssue).not.toHaveBeenCalled()
  })

  it('routes GitLab linked issues through repo context and moved worktree settings', async () => {
    const target = targetStatus({ id: 'done', label: 'Done' })
    const item = worktree({
      linkedLinearIssue: null,
      linkedGitLabIssue: 42,
      linkedGitLabProjectRef: { host: 'gitlab.example.com', path: 'group/project' }
    })
    const updateGitLabIssue = vi.fn().mockResolvedValue({ ok: true })
    const getSettingsForWorktree = vi.fn(() => ({ activeRuntimeEnvironmentId: 'runtime-owner' }))

    await expect(
      syncWorkspaceBoardTaskStatuses({
        worktreeIds: [item.id],
        targetStatus: target,
        worktreesById: new Map([[item.id, item]]),
        repoById: new Map([[item.repoId, repo({ id: item.repoId, path: '/repo-root' })]]),
        settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
        getSettingsForWorktree,
        getLatestWorkspaceStatus: () => target.id,
        deps: { updateGitLabIssue }
      })
    ).resolves.toEqual({ updated: 1, skipped: 0, failed: 0, messages: [] })

    expect(updateGitLabIssue).toHaveBeenCalledWith(
      { activeRuntimeEnvironmentId: 'runtime-owner' },
      {
        repoPath: '/repo-root',
        repoId: item.repoId,
        number: 42,
        projectRef: { host: 'gitlab.example.com', path: 'group/project' },
        updates: { state: 'closed' }
      }
    )
  })

  it('protects GitLab updates from stale local status after mapping', async () => {
    const target = targetStatus({ id: 'done', label: 'Done' })
    const item = worktree({ linkedLinearIssue: null, linkedGitLabIssue: 42 })
    const updateGitLabIssue = vi.fn()

    const result = await syncWorkspaceBoardTaskStatuses({
      worktreeIds: [item.id],
      targetStatus: target,
      worktreesById: new Map([[item.id, item]]),
      repoById: new Map([[item.repoId, repo({ id: item.repoId })]]),
      getLatestWorkspaceStatus: () => 'in-review',
      deps: { updateGitLabIssue }
    })

    expect(result).toEqual({ updated: 0, skipped: 1, failed: 0, messages: [] })
    expect(updateGitLabIssue).not.toHaveBeenCalled()
  })

  it('transitions Jira issues by matching the board status to a transition', async () => {
    const target = targetStatus()
    const item = worktree({ linkedLinearIssue: null, linkedJiraIssue: 'STA-776' })
    const getJiraIssue = vi.fn().mockResolvedValue(jiraIssue())
    const listJiraTransitions = vi.fn().mockResolvedValue([jiraTransition()])
    const updateJiraIssue = vi.fn().mockResolvedValue({ ok: true })
    await expect(
      syncWorkspaceBoardTaskStatuses({
        worktreeIds: [item.id],
        targetStatus: target,
        worktreesById: new Map([[item.id, item]]),
        settings: { activeRuntimeEnvironmentId: 'runtime:jira-owner' },
        getLatestWorkspaceStatus: () => target.id,
        deps: { getJiraIssue, listJiraTransitions, updateJiraIssue }
      })
    ).resolves.toEqual({ updated: 1, skipped: 0, failed: 0, messages: [] })

    expect(getJiraIssue).toHaveBeenCalledWith(
      { activeRuntimeEnvironmentId: 'runtime:jira-owner' },
      'STA-776',
      null
    )
    expect(updateJiraIssue).toHaveBeenCalledWith(
      { activeRuntimeEnvironmentId: 'runtime:jira-owner' },
      'STA-776',
      { transitionId: 'transition-review' },
      null
    )
  })

  it('routes Jira transition sync through persisted site metadata without source context', async () => {
    const target = targetStatus()
    const item = worktree({
      linkedLinearIssue: null,
      linkedJiraIssue: 'STA-776',
      linkedJiraIssueSiteId: 'site-from-worktree'
    })
    const getJiraIssue = vi.fn().mockResolvedValue(jiraIssue())
    const listJiraTransitions = vi.fn().mockResolvedValue([jiraTransition()])
    const updateJiraIssue = vi.fn().mockResolvedValue({ ok: true })

    await syncWorkspaceBoardTaskStatuses({
      worktreeIds: [item.id],
      targetStatus: target,
      worktreesById: new Map([[item.id, item]]),
      settings: { activeRuntimeEnvironmentId: 'runtime-owner' },
      getLatestWorkspaceStatus: () => target.id,
      deps: { getJiraIssue, listJiraTransitions, updateJiraIssue }
    })

    expect(getJiraIssue).toHaveBeenCalledWith(
      { activeRuntimeEnvironmentId: 'runtime-owner' },
      'STA-776',
      'site-from-worktree'
    )
    expect(updateJiraIssue).toHaveBeenCalledWith(
      { activeRuntimeEnvironmentId: 'runtime-owner' },
      'STA-776',
      { transitionId: 'transition-review' },
      'site-from-worktree'
    )
  })

  it('skips Jira transition sync when the local status changed after provider reads', async () => {
    const target = targetStatus()
    const item = worktree({ linkedLinearIssue: null, linkedJiraIssue: 'STA-776' })
    const getJiraIssue = vi.fn().mockResolvedValue(jiraIssue())
    const listJiraTransitions = vi.fn().mockResolvedValue([jiraTransition()])
    const updateJiraIssue = vi.fn()

    const result = await syncWorkspaceBoardTaskStatuses({
      worktreeIds: [item.id],
      targetStatus: target,
      worktreesById: new Map([[item.id, item]]),
      getLatestWorkspaceStatus: () => 'done',
      deps: { getJiraIssue, listJiraTransitions, updateJiraIssue }
    })

    expect(result).toEqual({ updated: 0, skipped: 1, failed: 0, messages: [] })
    expect(updateJiraIssue).not.toHaveBeenCalled()
  })

  it('skips missing or ambiguous Jira transition matches', async () => {
    const target = targetStatus()
    const missing = worktree({
      id: 'repo::/missing',
      linkedLinearIssue: null,
      linkedJiraIssue: 'A-1'
    })
    const ambiguous = worktree({
      id: 'repo::/ambiguous',
      linkedLinearIssue: null,
      linkedJiraIssue: 'A-2'
    })
    const getJiraIssue = vi.fn().mockResolvedValue(jiraIssue())
    const listJiraTransitions = vi
      .fn()
      .mockResolvedValueOnce([
        jiraTransition({ name: 'Done', to: { ...jiraTransition().to, name: 'Done' } })
      ])
      .mockResolvedValueOnce([
        jiraTransition({ id: 'transition-1' }),
        jiraTransition({ id: 'transition-2', name: ' in REVIEW ' })
      ])
    const updateJiraIssue = vi.fn()

    const result = await syncWorkspaceBoardTaskStatuses({
      worktreeIds: [missing.id, ambiguous.id],
      targetStatus: target,
      worktreesById: new Map([
        [missing.id, missing],
        [ambiguous.id, ambiguous]
      ]),
      getLatestWorkspaceStatus: () => target.id,
      deps: { getJiraIssue, listJiraTransitions, updateJiraIssue }
    })

    expect(result).toMatchObject({
      updated: 0,
      skipped: 2,
      failed: 0,
      messages: [
        { kind: 'missing-provider-status-mapping', provider: 'Jira', statusLabel: 'In review' },
        { kind: 'ambiguous-provider-status-mapping', provider: 'Jira', statusLabel: 'In review' }
      ]
    })
    expect(updateJiraIssue).not.toHaveBeenCalled()
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
          provider: 'Linear',
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
