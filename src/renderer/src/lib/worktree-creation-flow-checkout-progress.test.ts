import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PendingWorktreeCreation,
  WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'

const { prepareEphemeralVmWorkspaceTargetMock } = vi.hoisted(() => ({
  prepareEphemeralVmWorkspaceTargetMock: vi.fn()
}))

type TestSettings = {
  activeRuntimeEnvironmentId: string | null
  experimentalNativeChat?: boolean
  openAgentTabsInChatByDefault?: boolean
}
const settings: TestSettings = { activeRuntimeEnvironmentId: null }
const activeView: 'terminal' | 'tasks' = 'terminal'
const activePendingCreationId: string | null = 'creation-1'
const pendingWorktreeCreations: Record<string, PendingWorktreeCreation> = {}
const tabsByWorktree: Record<string, { id: string; launchAgent?: string }[]> = {}

const store = {
  settings,
  activeView,
  activePendingCreationId,
  repos: [{ id: 'repo-runtime', connectionId: null }],
  pendingWorktreeCreations,
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
  }),
  updateWorktreeMeta: vi.fn(),
  setActivePendingWorktreeCreation: vi.fn(),
  setActiveView: vi.fn(),
  setSidebarOpen: vi.fn(),
  createWorktree: vi.fn(() => new Promise(() => {})),
  setupProjectExistingFolder: vi.fn(),
  refreshRuntimeEnvironmentStatus: vi.fn(),
  seedNativeChatLaunchDraft: vi.fn(),
  setTabViewMode: vi.fn(),
  tabsByWorktree,
  unifiedTabsByWorktree: {}
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store
  }
}))

vi.mock('@/lib/browser-uuid', () => ({
  createBrowserUuid: () => 'creation-1'
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn(() => false)
}))

vi.mock('@/lib/worktree-initial-terminal-seeding', () => ({
  ensureWorktreeHasInitialTerminal: vi.fn()
}))

vi.mock('@/lib/workspace-activation-terminal-focus', () => ({
  queueWorkspaceActivationTerminalFocus: vi.fn()
}))

vi.mock('@/lib/new-workspace', () => ({
  ensureAgentStartupInTerminal: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn()
  }
}))

vi.mock('@/lib/ephemeral-vm-workspace-target', () => ({
  prepareEphemeralVmWorkspaceTarget: prepareEphemeralVmWorkspaceTargetMock
}))

import {
  continueBackgroundWorktreeCreation,
  retryBackgroundWorktreeCreation
} from './worktree-creation-flow'

const request: WorktreeCreationRequest = {
  repoId: 'repo-1',
  name: 'feature',
  setupDecision: 'inherit',
  agent: null,
  pendingFirstAgentMessageRename: false,
  note: '',
  startupPlan: null,
  quickPrompt: '',
  quickTelemetry: null
}

// A create that failed while git was 40% through its checkout.
function failedMidCheckout(): PendingWorktreeCreation {
  return {
    creationId: 'creation-1',
    phase: 'creating',
    status: 'error',
    error: 'git worktree add failed',
    startedAt: 1,
    indeterminate: false,
    loaderVisible: true,
    checkoutProgress: { percent: 40, completed: 400, total: 1000 },
    request
  }
}

describe('a restarted create drops the previous attempt’s checkout meter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.pendingWorktreeCreations = { 'creation-1': failedMidCheckout() }
  })

  it('on Retry', () => {
    retryBackgroundWorktreeCreation('creation-1')

    expect(store.pendingWorktreeCreations['creation-1']).toMatchObject({
      status: 'creating',
      phase: 'fetching'
    })
    expect(store.pendingWorktreeCreations['creation-1'].checkoutProgress).toBeUndefined()
  })

  it('when a staged create continues', () => {
    expect(continueBackgroundWorktreeCreation('creation-1', request)).toBe(true)

    expect(store.pendingWorktreeCreations['creation-1'].status).toBe('creating')
    expect(store.pendingWorktreeCreations['creation-1'].checkoutProgress).toBeUndefined()
  })
})
