import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PendingWorktreeCreation,
  WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'
import type { CreateWorktreeResult } from '../../../shared/worktree/create-types'
import type * as EphemeralVmWorktreeCreationModule from '@/lib/ephemeral-vm-worktree-creation'

type ReadyToastCall = { message: string; onClick: () => void }

const { readyToast, attachVmRuntime } = vi.hoisted(() => {
  const calls: ReadyToastCall[] = []
  return {
    readyToast: { calls },
    attachVmRuntime: vi.fn<() => Promise<void>>(async () => {})
  }
})

type NavigationState = {
  activeView: 'terminal' | 'tasks'
  activePendingCreationId: string | null
  activeWorktreeId: string | null
  pendingWorktreeCreations: Record<string, PendingWorktreeCreation>
}
const navigation: NavigationState = {
  activeView: 'terminal',
  activePendingCreationId: null,
  activeWorktreeId: null,
  pendingWorktreeCreations: {}
}

// Pending-creation actions mirror the real slice: begin points the panel at the entry, remove clears it.
const store = Object.assign(navigation, {
  settings: {},
  repos: [],
  beginPendingWorktreeCreation: vi.fn((entry: PendingWorktreeCreation) => {
    store.pendingWorktreeCreations[entry.creationId] = entry
    store.activePendingCreationId = entry.creationId
  }),
  updatePendingWorktreeCreation: vi.fn(
    (creationId: string, patch: Partial<PendingWorktreeCreation>) => {
      const entry = store.pendingWorktreeCreations[creationId]
      if (entry) {
        store.pendingWorktreeCreations[creationId] = { ...entry, ...patch }
      }
    }
  ),
  removePendingWorktreeCreation: vi.fn((creationId: string) => {
    delete store.pendingWorktreeCreations[creationId]
    if (store.activePendingCreationId === creationId) {
      store.activePendingCreationId = null
    }
  }),
  updateWorktreeMeta: vi.fn(),
  setActivePendingWorktreeCreation: vi.fn(),
  setActiveView: vi.fn((view: NavigationState['activeView']) => {
    store.activeView = view
  }),
  setSidebarOpen: vi.fn(),
  createWorktree: vi.fn<() => Promise<CreateWorktreeResult>>(),
  seedNativeChatLaunchDraft: vi.fn(),
  setTabViewMode: vi.fn(),
  tabsByWorktree: {},
  unifiedTabsByWorktree: {}
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store
  }
}))

vi.mock('@/lib/browser-uuid', () => ({
  createBrowserUuid: () => 'creation-1'
}))

// Agent creates return no primary tab: the agent's own surface is the worktree's active tab.
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn(() => ({ primaryTabId: null }))
}))

vi.mock('@/lib/worktree-initial-terminal-seeding', () => ({
  ensureWorktreeHasInitialTerminal: vi.fn(() => 'tab-1')
}))

vi.mock('@/lib/workspace-activation-terminal-focus', () => ({
  queueWorkspaceActivationTerminalFocus: vi.fn()
}))

vi.mock('@/lib/new-workspace', () => ({
  ensureAgentStartupInTerminal: vi.fn()
}))

vi.mock('@/lib/worktree-creation-agent-seeds', () => ({
  seedAgentTabStateAfterWorktreeCreate: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn((message: string, options: { action: { onClick: () => void } }) => {
      readyToast.calls.push({ message, onClick: options.action.onClick })
    })
  }
}))

vi.mock('@/lib/ephemeral-vm-workspace-target', () => ({
  prepareEphemeralVmWorkspaceTarget: vi.fn()
}))

vi.mock('@/lib/ephemeral-vm-worktree-creation', async (importOriginal) => ({
  ...(await importOriginal<typeof EphemeralVmWorktreeCreationModule>()),
  attachEphemeralVmRuntimeToWorkspace: attachVmRuntime
}))

import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { queueWorkspaceActivationTerminalFocus } from '@/lib/workspace-activation-terminal-focus'
import { runBackgroundWorktreeCreation } from './worktree-creation-flow'

function makeRequest(overrides: Partial<WorktreeCreationRequest> = {}): WorktreeCreationRequest {
  return {
    repoId: 'repo-1',
    name: 'feature',
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

function makeCreateResult(overrides: Partial<CreateWorktreeResult> = {}): CreateWorktreeResult {
  return {
    worktree: makeWorktree({ id: 'wt-1', repoId: 'repo-1', displayName: 'Feature' }),
    ...overrides
  }
}

// Submits like the composer does, holding createWorktree open until the test resolves it.
async function submitCreate(
  result: CreateWorktreeResult = makeCreateResult(),
  request: WorktreeCreationRequest = makeRequest()
): Promise<() => void> {
  let resolve!: (value: CreateWorktreeResult) => void
  store.createWorktree.mockReturnValueOnce(new Promise((r) => (resolve = r)))
  expect(runBackgroundWorktreeCreation(request)).toBe('creation-1')
  expect(store.activePendingCreationId).toBe('creation-1')
  await vi.waitFor(() => expect(store.createWorktree).toHaveBeenCalledTimes(1))
  return () => resolve(result)
}

// setActiveWorktree clears the pending-creation pointer when the user picks a workspace.
function selectWorkspace(worktreeId: string): void {
  store.activePendingCreationId = null
  store.activeWorktreeId = worktreeId
}

beforeEach(() => {
  vi.clearAllMocks()
  readyToast.calls.length = 0
  store.activeView = 'terminal'
  store.activePendingCreationId = null
  store.activeWorktreeId = null
  store.pendingWorktreeCreations = {}
})

describe('a creation that finishes after the user moved on (#9944)', () => {
  it('keeps the user on the workspace they switched to and offers the new one in a toast', async () => {
    const finish = await submitCreate()
    selectWorkspace('wt-other')
    finish()
    await vi.waitFor(() => expect(store.removePendingWorktreeCreation).toHaveBeenCalled())

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(queueWorkspaceActivationTerminalFocus).not.toHaveBeenCalled()
    expect(readyToast.calls).toHaveLength(1)
    expect(readyToast.calls[0]?.message).toBe('Worktree Feature is ready')

    readyToast.calls[0]?.onClick()
    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-1', {
      sidebarRevealBehavior: 'auto',
      navigationIntent: 'user-open'
    })
  })

  it('toasts when the user left for another app view', async () => {
    const finish = await submitCreate()
    store.activeView = 'tasks'
    finish()
    await vi.waitFor(() => expect(store.removePendingWorktreeCreation).toHaveBeenCalled())

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(readyToast.calls).toHaveLength(1)
  })

  it('hands a backend-started agent workspace to a user still watching, without a toast', async () => {
    const finish = await submitCreate(
      makeCreateResult({ startupTerminal: { spawned: true, surface: 'visible' } }),
      makeRequest({
        agent: 'claude',
        startupPlan: {
          agent: 'claude',
          launchCommand: 'claude',
          expectedProcess: 'claude',
          launchConfig: { agentArgs: '', agentEnv: {} }
        }
      })
    )
    finish()
    await vi.waitFor(() => expect(store.removePendingWorktreeCreation).toHaveBeenCalled())

    // The host already adopted the agent tab, so activation must seed nothing beside it;
    // worktree-creation-backend-startup-focus.test.ts pins that this lands focus on that tab.
    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-1', {
      sidebarRevealBehavior: 'auto',
      agent: 'claude',
      backendStartupTerminalSpawned: true
    })
    expect(queueWorkspaceActivationTerminalFocus).toHaveBeenCalledWith('wt-1', {
      primaryTabId: null
    })
    expect(readyToast.calls).toHaveLength(0)
  })

  it('does not toast a creation cancelled after the workspace was created', async () => {
    // Cancel lands while the created workspace is still being wired up, past the post-create cancel check.
    attachVmRuntime.mockImplementationOnce(async () => {
      store.removePendingWorktreeCreation('creation-1')
    })
    const finish = await submitCreate()
    finish()
    await vi.waitFor(() => expect(attachVmRuntime).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(readyToast.calls).toHaveLength(0)
  })

  it('hands the workspace over without a toast to a user who already opened it', async () => {
    const finish = await submitCreate()
    // The created row is listed before completion; clicking it opens the new workspace.
    selectWorkspace('wt-1')
    finish()
    await vi.waitFor(() => expect(store.removePendingWorktreeCreation).toHaveBeenCalled())

    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-1', {
      sidebarRevealBehavior: 'auto'
    })
    expect(queueWorkspaceActivationTerminalFocus).toHaveBeenCalledWith('wt-1', {
      primaryTabId: null
    })
    expect(readyToast.calls).toHaveLength(0)
  })
})
