import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'

const store = {
  settings: {
    activeRuntimeEnvironmentId: null as string | null,
    agentProfiles: []
  },
  repos: [{ id: 'repo-1', path: '/repo/main', connectionId: null }],
  pendingWorktreeCreations: {} as Record<string, unknown>,
  activePendingCreationId: 'creation-1' as string | null,
  beginPendingWorktreeCreation: vi.fn(),
  setActiveView: vi.fn(),
  setSidebarOpen: vi.fn(),
  setActivePendingWorktreeCreation: vi.fn(),
  updatePendingWorktreeCreation: vi.fn(),
  removePendingWorktreeCreation: vi.fn(),
  updateWorktreeMeta: vi.fn(),
  createWorktree: vi.fn(() => new Promise(() => {}))
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
  activateAndRevealWorktree: vi.fn(),
  ensureWorktreeHasInitialTerminal: vi.fn()
}))

vi.mock('@/lib/new-workspace-terminal-focus', () => ({
  queueNewWorkspaceTerminalFocus: vi.fn()
}))

vi.mock('@/lib/new-workspace', () => ({
  ensureAgentStartupInTerminal: vi.fn()
}))

import { runBackgroundWorktreeCreation } from './worktree-creation-flow'
import { ensureAgentStartupInTerminal } from '@/lib/new-workspace'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'

const FLOW_SOURCE = readFileSync(join(__dirname, 'worktree-creation-flow.ts'), 'utf8')

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

function sourceBetween(source: string, startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('runBackgroundWorktreeCreation', () => {
  beforeEach(() => {
    store.settings = { activeRuntimeEnvironmentId: null, agentProfiles: [] }
    store.repos = [{ id: 'repo-1', path: '/repo/main', connectionId: null }]
    store.pendingWorktreeCreations = {}
    store.activePendingCreationId = 'creation-1'
    store.beginPendingWorktreeCreation.mockImplementation((entry) => {
      store.pendingWorktreeCreations[entry.creationId] = entry
    })
    store.createWorktree.mockReset()
    store.createWorktree.mockImplementation(() => new Promise(() => {}))
    store.removePendingWorktreeCreation.mockClear()
    store.updateWorktreeMeta.mockClear()
    vi.mocked(ensureAgentStartupInTerminal).mockClear()
    vi.mocked(activateAndRevealWorktree).mockReset()
    vi.mocked(activateAndRevealWorktree).mockReturnValue({
      primaryTabId: 'tab-1'
    })
  })

  it('uses the captured repo-owner progress mode instead of focused runtime state', () => {
    store.settings.activeRuntimeEnvironmentId = null
    store.beginPendingWorktreeCreation.mockClear()

    runBackgroundWorktreeCreation(makeRequest({ worktreeCreateProgressMode: 'indeterminate' }))

    expect(store.beginPendingWorktreeCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        creationId: 'creation-1',
        indeterminate: true,
        request: expect.objectContaining({
          worktreeCreateProgressMode: 'indeterminate'
        })
      })
    )
  })

  it('falls back to focused runtime state for legacy captured requests', () => {
    store.settings.activeRuntimeEnvironmentId = 'focused-runtime'
    store.beginPendingWorktreeCreation.mockClear()

    runBackgroundWorktreeCreation(makeRequest())

    expect(store.beginPendingWorktreeCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        indeterminate: true,
        request: expect.not.objectContaining({
          worktreeCreateProgressMode: expect.any(String)
        })
      })
    )
  })

  it('resolves startup profile path variables after the worktree is created', async () => {
    store.createWorktree.mockResolvedValueOnce({
      worktree: { id: 'wt-1', repoId: 'repo-1', path: '/worktrees/feature' },
      startupTerminal: { spawned: false }
    })

    runBackgroundWorktreeCreation(
      makeRequest({
        agent: 'agent-profile:claude-work',
        quickPrompt: 'fix it',
        startupPlanTemplate: {
          agent: 'agent-profile:claude-work',
          prompt: 'fix it',
          cmdOverrides: {},
          agentDefaultArgs: {
            'agent-profile:claude-work': '--plugin-dir {worktreePath}/plugins --repo {repoPath}'
          },
          agentProfiles: [
            {
              id: 'agent-profile:claude-work',
              baseAgent: 'claude',
              label: 'Claude Work'
            }
          ],
          platform: 'linux'
        }
      })
    )

    await vi.waitFor(() => expect(ensureAgentStartupInTerminal).toHaveBeenCalled())

    expect(ensureAgentStartupInTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        startup: expect.objectContaining({
          launchCommand:
            "claude '--plugin-dir' '/worktrees/feature/plugins' '--repo' '/repo/main' 'fix it'"
        })
      })
    )
  })
})

describe('worktree creation flow agent trust preflight', () => {
  it('forwards the repo SSH connection id when pre-marking agent trust', () => {
    const preflight = sourceBetween(
      FLOW_SOURCE,
      'async function preflightAgentTrust',
      'async function executeWorktreeCreation'
    )
    const createFlow = sourceBetween(
      FLOW_SOURCE,
      'const backendSpawned = result.startupTerminal?.spawned === true',
      '// `createWorktree` already inserted the real worktree row'
    )

    expect(preflight).toContain('connectionId?: string | null')
    expect(preflight).toContain('...(connectionId ? { connectionId } : {})')
    expect(createFlow).toContain('repoConnectionId')
    expect(createFlow).toContain('entry.id === worktree.repoId')
    expect(createFlow).toContain(
      'await preflightAgentTrust(request, worktree.path, repoConnectionId)'
    )
  })
})
