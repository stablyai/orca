import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Automation,
  AutomationDispatchResult,
  AutomationRun
} from '../../../shared/automations-types'

const mockCreateWorktree = vi.fn()
const mockSearchRuntimeRepoBaseRefs = vi.fn()
const mockMarkDispatchResult = vi.fn<(result: AutomationDispatchResult) => Promise<void>>()

vi.mock('@/store', () => {
  const state = {
    repos: [{ id: 'repo-1', connectionId: null, executionHostId: null, path: '/repo' }],
    settings: null,
    allWorktrees: () => [],
    getKnownWorktreeById: () => undefined,
    createWorktree: mockCreateWorktree
  }
  return { useAppStore: { getState: () => state, subscribe: vi.fn(() => () => {}) } }
})

vi.mock('@/runtime/runtime-repo-client', () => ({
  searchRuntimeRepoBaseRefs: mockSearchRuntimeRepoBaseRefs
}))

vi.mock('@/lib/launch-worktree-background-terminals', () => ({
  launchWorktreeBackgroundTerminals: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const automation: Automation = {
  id: 'automation-1',
  name: 'Nightly',
  prompt: 'run this',
  precheck: null,
  agentId: 'claude',
  projectId: 'repo-1',
  executionTargetType: 'local',
  executionTargetId: 'local',
  schedulerOwner: 'local_host_service',
  workspaceMode: 'new_per_run',
  workspaceId: null,
  baseBranch: null,
  setupDecision: 'skip',
  reuseSession: false,
  timezone: 'UTC',
  rrule: 'FREQ=DAILY',
  dtstart: 1,
  enabled: true,
  nextRunAt: 2,
  missedRunPolicy: 'run_once_within_grace',
  missedRunGraceMinutes: 720,
  createdAt: 1,
  updatedAt: 1
}

const run: AutomationRun = {
  id: 'run-1',
  automationId: 'automation-1',
  title: 'Nightly run',
  scheduledFor: Date.parse('2026-06-24T03:00:00Z'),
  status: 'dispatching',
  trigger: 'manual',
  workspaceId: null,
  sessionKind: 'terminal',
  chatSessionId: null,
  terminalSessionId: null,
  terminalPaneKey: null,
  terminalPtyId: null,
  outputSnapshot: null,
  precheckResult: null,
  usage: null,
  error: null,
  startedAt: null,
  dispatchedAt: null,
  createdAt: 1
}

async function dispatchWithBaseBranch(baseBranch: string | null): Promise<unknown> {
  const { useAppStore } = await import('@/store')
  const { prepareAutomationDispatchWorkspace, resolveAutomationDispatchWorkspace } =
    await import('./automation-dispatch-workspace')
  const state = useAppStore.getState()
  const runAutomation = { ...automation, baseBranch }
  const resolved = resolveAutomationDispatchWorkspace(state, runAutomation, run)
  const repo = resolved.repo
  if (!repo) {
    throw new Error('test repo did not resolve')
  }
  await prepareAutomationDispatchWorkspace({
    state,
    automation: runAutomation,
    run,
    dispatchToken: 'dispatch-token',
    resolved: { ...resolved, repo },
    markDispatchResult: mockMarkDispatchResult
  })
  return mockCreateWorktree.mock.calls[0]?.[2]
}

describe('automation dispatch workspace base branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateWorktree.mockResolvedValue({ worktree: { id: 'wt-1', displayName: 'Run' } })
    mockSearchRuntimeRepoBaseRefs.mockResolvedValue([])
    mockMarkDispatchResult.mockResolvedValue(undefined)
  })

  it('starts a bare base branch from its remote-tracking ref so unpushed commits stay out', async () => {
    mockSearchRuntimeRepoBaseRefs.mockResolvedValue(['origin/main', 'origin/main-old'])

    await expect(dispatchWithBaseBranch('main')).resolves.toBe('origin/main')
    expect(mockSearchRuntimeRepoBaseRefs).toHaveBeenCalledWith(
      { activeRuntimeEnvironmentId: null },
      'repo-1',
      'origin/main',
      expect.any(Number),
      'local'
    )
  })

  it('keeps a local-only base branch when no remote-tracking ref matches exactly', async () => {
    mockSearchRuntimeRepoBaseRefs.mockResolvedValue(['origin/feature-old'])

    await expect(dispatchWithBaseBranch('feature')).resolves.toBe('feature')
  })

  it('keeps an explicit remote-tracking base without searching refs', async () => {
    await expect(dispatchWithBaseBranch('origin/main')).resolves.toBe('origin/main')
    expect(mockSearchRuntimeRepoBaseRefs).not.toHaveBeenCalled()
  })

  it('leaves an unset base to the project default', async () => {
    await expect(dispatchWithBaseBranch(null)).resolves.toBeUndefined()
    expect(mockSearchRuntimeRepoBaseRefs).not.toHaveBeenCalled()
  })

  it('keeps the stored base when the ref search fails', async () => {
    mockSearchRuntimeRepoBaseRefs.mockRejectedValue(new Error('connection dropped'))

    await expect(dispatchWithBaseBranch('main')).resolves.toBe('main')
  })
})
