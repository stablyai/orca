import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'

const storeState = vi.hoisted(() => ({
  value: {} as Partial<AppState> & {
    ensureDetectedAgents: ReturnType<typeof vi.fn>
    createWorktree: ReturnType<typeof vi.fn>
    updateWorktreeMeta: ReturnType<typeof vi.fn>
    setSidebarOpen: ReturnType<typeof vi.fn>
  }
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeState.value
  }
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn()
  }
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: vi.fn()
}))

vi.mock('@/lib/tui-agent-startup', () => ({
  buildAgentDraftLaunchPlan: vi.fn(() => null),
  buildAgentStartupPlan: vi.fn(() => null)
}))

vi.mock('../../../shared/tui-agent-selection', () => ({
  pickTuiAgent: vi.fn(() => null)
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn(() => ({ primaryTabId: 'tab-1' }))
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  getActiveRuntimeTarget: vi.fn(() => ({ kind: 'local' }))
}))

vi.mock('@/lib/new-workspace', () => ({
  CLIENT_PLATFORM: 'darwin',
  getWorkspaceIntentName: (args: {
    workItem?: { type: 'issue' | 'pr' | 'mr'; number: number; title: string } | null
  }) =>
    args.workItem
      ? {
          displayName:
            args.workItem.type === 'pr'
              ? `Review PR ${args.workItem.number}`
              : `Issue ${args.workItem.number}`,
          seedName:
            args.workItem.type === 'pr'
              ? `review-pr-${args.workItem.number}`
              : `issue-${args.workItem.number}`
        }
      : null,
  getSetupConfig: vi.fn(() => null),
  getWorkspaceSeedName: ({ explicitName }: { explicitName?: string }) => explicitName ?? '',
  isGitLabIssueUrl: vi.fn(() => false)
}))

vi.mock('@/lib/ensure-hooks-confirmed', () => ({
  ensureHooksConfirmed: vi.fn(async () => 'run')
}))

vi.mock('@/runtime/runtime-hooks-client', () => ({
  checkRuntimeHooks: vi.fn(async () => ({ hasHooks: false, hooks: null, mayNeedUpdate: false }))
}))

vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: vi.fn(() => 'codex')
}))

import { launchWorkItemDirect } from './launch-work-item-direct'

const mockApi = {
  worktrees: {
    resolvePrBase: vi.fn()
  }
}

describe('launchWorkItemDirect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.resolvePrBase.mockResolvedValue({
      baseBranch: 'abc123',
      headSha: 'abc123',
      branchNameOverride: 'feature/fix',
      pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
    })
    storeState.value = {
      repos: [
        {
          id: 'repo-1',
          path: '/repo',
          displayName: 'Repo',
          badgeColor: '#000',
          addedAt: 0
        }
      ],
      settings: {},
      ensureDetectedAgents: vi.fn(async () => []),
      createWorktree: vi.fn(async () => ({
        worktree: { id: 'wt-1', path: '/repo/../worktrees/fix' }
      })),
      updateWorktreeMeta: vi.fn(async () => undefined),
      setSidebarOpen: vi.fn()
    } as typeof storeState.value
    // @ts-expect-error -- test shim
    globalThis.window = { api: mockApi }
  })

  it('passes a resolved PR branch override while using a short PR identity for workspace names', async () => {
    await launchWorkItemDirect({
      repoId: 'repo-1',
      launchSource: 'task_page',
      telemetrySource: 'sidebar',
      openModalFallback: vi.fn(),
      item: {
        type: 'pr',
        number: 42,
        title: 'Fix the bug',
        url: 'https://github.com/acme/repo/pull/42'
      }
    })

    expect(storeState.value.createWorktree).toHaveBeenCalledWith(
      'repo-1',
      'review-pr-42',
      'abc123',
      'inherit',
      undefined,
      'sidebar',
      'Review PR 42',
      undefined,
      42,
      { remoteName: 'origin', branchName: 'feature/fix' },
      undefined,
      undefined,
      'feature/fix',
      undefined,
      undefined,
      undefined
    )
  })

  it('uses the Linear identifier in direct-launch workspace names', async () => {
    await launchWorkItemDirect({
      repoId: 'repo-1',
      launchSource: 'task_page',
      telemetrySource: 'sidebar',
      openModalFallback: vi.fn(),
      item: {
        type: 'issue',
        number: null,
        title: 'Ship Linear parity',
        url: 'https://linear.app/acme/issue/ENG-42/ship-linear-parity',
        linearIdentifier: 'ENG-42'
      }
    })

    expect(storeState.value.createWorktree).toHaveBeenCalledWith(
      'repo-1',
      'eng-42-ship-linear-parity',
      undefined,
      'inherit',
      undefined,
      'sidebar',
      'Ship Linear parity',
      undefined,
      undefined,
      undefined,
      undefined,
      'ENG-42',
      undefined,
      undefined,
      undefined,
      undefined
    )
  })
})
