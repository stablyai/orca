/* eslint-disable max-lines -- Why: this focused workflow suite keeps all
   quick-create fallback and creation policy permutations together. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { quickCreateDefaultWorkspace } from './quick-create-default-workspace'
import { useAppStore } from '@/store'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { ensureAgentStartupInTerminal, getSetupConfig } from '@/lib/new-workspace'
import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import type { Repo } from '../../../shared/types'

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: vi.fn()
  }
}))

vi.mock('@/lib/ensure-hooks-confirmed', () => ({
  ensureHooksConfirmed: vi.fn()
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/new-workspace', () => ({
  CLIENT_PLATFORM: 'darwin',
  ensureAgentStartupInTerminal: vi.fn(),
  getSetupConfig: vi.fn()
}))

vi.mock('@/lib/tui-agent-startup', () => ({
  buildAgentStartupPlan: vi.fn()
}))

vi.mock('@/lib/telemetry', () => ({
  tuiAgentToAgentKind: (agent: string) => agent
}))

vi.mock('@/components/sidebar/worktree-name-suggestions', () => ({
  getSuggestedCreatureName: vi.fn(() => 'quick-workspace')
}))

type QuickCreateState = {
  settings: {
    quickCreateWorkspaceWithDefaultAgent: boolean
    defaultTuiAgent: string | null
    nestWorkspaces: boolean
    rightSidebarOpenByDefault: boolean
    agentCmdOverrides: Record<string, string>
    disabledTuiAgents: string[]
  }
  activeWorktreeId: string | null
  activeRepoId: string | null
  repos: Repo[]
  worktreesByRepo: Record<string, { id: string; repoId: string; path: string }[]>
  ensureDetectedAgents: ReturnType<typeof vi.fn>
  ensureRemoteDetectedAgents: ReturnType<typeof vi.fn>
  createWorktree: ReturnType<typeof vi.fn>
  setSidebarOpen: ReturnType<typeof vi.fn>
  setRightSidebarTab: ReturnType<typeof vi.fn>
  setRightSidebarOpen: ReturnType<typeof vi.fn>
}

const localRepo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: '#fff',
  addedAt: 1,
  kind: 'git',
  hookSettings: {
    mode: 'auto',
    setupRunPolicy: 'run-by-default',
    scripts: { setup: '', archive: '' }
  }
}

function makeState(overrides: Partial<QuickCreateState> = {}): QuickCreateState {
  return {
    settings: {
      quickCreateWorkspaceWithDefaultAgent: true,
      defaultTuiAgent: 'codex',
      nestWorkspaces: false,
      rightSidebarOpenByDefault: false,
      agentCmdOverrides: {},
      disabledTuiAgents: [],
      ...overrides.settings
    },
    activeWorktreeId: null,
    activeRepoId: localRepo.id,
    repos: [localRepo],
    worktreesByRepo: {},
    ensureDetectedAgents: vi.fn().mockResolvedValue(['codex']),
    ensureRemoteDetectedAgents: vi.fn().mockResolvedValue(['codex']),
    createWorktree: vi.fn().mockResolvedValue({
      worktree: { id: 'wt-1', path: '/repo/worktrees/quick-workspace' },
      setup: undefined
    }),
    setSidebarOpen: vi.fn(),
    setRightSidebarTab: vi.fn(),
    setRightSidebarOpen: vi.fn(),
    ...overrides
  }
}

async function runQuickCreate(
  state: QuickCreateState,
  openModalFallback = vi.fn()
): Promise<ReturnType<typeof vi.fn>> {
  vi.mocked(useAppStore.getState).mockImplementation(() => state as never)
  await quickCreateDefaultWorkspace({ openModalFallback })
  return openModalFallback
}

describe('quickCreateDefaultWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      api: {
        hooks: {
          check: vi.fn().mockResolvedValue({ hooks: null })
        },
        agentTrust: {
          markTrusted: vi.fn()
        }
      }
    })
    vi.mocked(ensureHooksConfirmed).mockResolvedValue('run')
    vi.mocked(getSetupConfig).mockReturnValue(null)
    vi.mocked(buildAgentStartupPlan).mockReturnValue({
      agent: 'codex',
      launchCommand: 'codex',
      expectedProcess: 'codex',
      followupPrompt: null
    })
  })

  it('falls back to the composer when quick-create is disabled', async () => {
    const state = makeState({
      settings: {
        quickCreateWorkspaceWithDefaultAgent: false,
        defaultTuiAgent: 'codex',
        nestWorkspaces: false,
        rightSidebarOpenByDefault: false,
        agentCmdOverrides: {},
        disabledTuiAgents: []
      }
    })

    const openModalFallback = await runQuickCreate(state)

    expect(openModalFallback).toHaveBeenCalledTimes(1)
    expect(state.createWorktree).not.toHaveBeenCalled()
  })

  it('falls back to the composer when no default agent is configured', async () => {
    const state = makeState({
      settings: {
        quickCreateWorkspaceWithDefaultAgent: true,
        defaultTuiAgent: null,
        nestWorkspaces: false,
        rightSidebarOpenByDefault: false,
        agentCmdOverrides: {},
        disabledTuiAgents: []
      }
    })

    const openModalFallback = await runQuickCreate(state)

    expect(openModalFallback).toHaveBeenCalledTimes(1)
    expect(state.ensureDetectedAgents).not.toHaveBeenCalled()
    expect(state.createWorktree).not.toHaveBeenCalled()
  })

  it('falls back to the composer when the active repo cannot be resolved', async () => {
    const state = makeState({
      activeRepoId: null,
      repos: [],
      worktreesByRepo: {}
    })

    const openModalFallback = await runQuickCreate(state)

    expect(openModalFallback).toHaveBeenCalledTimes(1)
    expect(state.ensureDetectedAgents).not.toHaveBeenCalled()
    expect(state.createWorktree).not.toHaveBeenCalled()
  })

  it('falls back when the default agent is not detected', async () => {
    const state = makeState({
      ensureDetectedAgents: vi.fn().mockResolvedValue([])
    })

    const openModalFallback = await runQuickCreate(state)

    expect(state.ensureDetectedAgents).toHaveBeenCalledTimes(1)
    expect(openModalFallback).toHaveBeenCalledTimes(1)
    expect(state.createWorktree).not.toHaveBeenCalled()
  })

  it('falls back when the configured default agent is disabled', async () => {
    const state = makeState({
      settings: {
        quickCreateWorkspaceWithDefaultAgent: true,
        defaultTuiAgent: 'codex',
        nestWorkspaces: false,
        rightSidebarOpenByDefault: false,
        agentCmdOverrides: {},
        disabledTuiAgents: ['codex']
      }
    })

    const openModalFallback = await runQuickCreate(state)

    expect(openModalFallback).toHaveBeenCalledTimes(1)
    expect(state.ensureDetectedAgents).not.toHaveBeenCalled()
    expect(state.createWorktree).not.toHaveBeenCalled()
  })

  it('falls back when setup policy requires an explicit choice', async () => {
    const state = makeState({
      repos: [
        {
          ...localRepo,
          hookSettings: {
            mode: 'auto',
            setupRunPolicy: 'ask',
            scripts: { setup: '', archive: '' }
          }
        }
      ]
    })
    vi.mocked(getSetupConfig).mockReturnValue({ source: 'yaml', command: 'pnpm install' })

    const openModalFallback = await runQuickCreate(state)

    expect(openModalFallback).toHaveBeenCalledTimes(1)
    expect(ensureHooksConfirmed).not.toHaveBeenCalled()
    expect(state.createWorktree).not.toHaveBeenCalled()
  })

  it('creates a blank workspace without agent startup', async () => {
    const state = makeState({
      settings: {
        quickCreateWorkspaceWithDefaultAgent: true,
        defaultTuiAgent: 'blank',
        nestWorkspaces: false,
        rightSidebarOpenByDefault: false,
        agentCmdOverrides: {},
        disabledTuiAgents: []
      }
    })
    vi.mocked(ensureHooksConfirmed).mockResolvedValue('skip')

    const openModalFallback = await runQuickCreate(state)

    expect(openModalFallback).not.toHaveBeenCalled()
    expect(state.createWorktree).toHaveBeenCalledWith(
      localRepo.id,
      'quick-workspace',
      undefined,
      'skip',
      undefined,
      'sidebar',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    )
    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-1', { setup: undefined })
    expect(buildAgentStartupPlan).not.toHaveBeenCalled()
    expect(ensureAgentStartupInTerminal).not.toHaveBeenCalled()
  })

  it('creates a workspace and launches the configured default agent', async () => {
    const state = makeState({
      settings: {
        quickCreateWorkspaceWithDefaultAgent: true,
        defaultTuiAgent: 'codex',
        nestWorkspaces: true,
        rightSidebarOpenByDefault: true,
        agentCmdOverrides: { codex: 'codex --model gpt-5.4' },
        disabledTuiAgents: []
      }
    })
    vi.mocked(getSetupConfig).mockReturnValue({ source: 'yaml', command: 'pnpm install' })

    const openModalFallback = await runQuickCreate(state)

    expect(openModalFallback).not.toHaveBeenCalled()
    expect(state.createWorktree).toHaveBeenCalledWith(
      localRepo.id,
      'quick-workspace',
      undefined,
      'run',
      undefined,
      'sidebar',
      undefined,
      undefined,
      undefined,
      undefined,
      'codex'
    )
    expect(buildAgentStartupPlan).toHaveBeenCalledWith({
      agent: 'codex',
      prompt: '',
      cmdOverrides: { codex: 'codex --model gpt-5.4' },
      platform: 'darwin',
      allowEmptyPromptLaunch: true
    })
    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-1', {
      setup: undefined,
      startup: {
        command: 'codex',
        telemetry: {
          agent_kind: 'codex',
          launch_source: 'sidebar',
          request_kind: 'new'
        }
      }
    })
    expect(ensureAgentStartupInTerminal).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      startup: {
        agent: 'codex',
        launchCommand: 'codex',
        expectedProcess: 'codex',
        followupPrompt: null
      }
    })
    expect(state.setSidebarOpen).toHaveBeenCalledWith(true)
    expect(state.setRightSidebarTab).toHaveBeenCalledWith('explorer')
    expect(state.setRightSidebarOpen).toHaveBeenCalledWith(true)
  })

  it('uses remote agent detection when the resolved repo is SSH-backed', async () => {
    const state = makeState({
      repos: [{ ...localRepo, connectionId: 'ssh-1' }]
    })

    const openModalFallback = await runQuickCreate(state)

    expect(openModalFallback).not.toHaveBeenCalled()
    expect(state.ensureRemoteDetectedAgents).toHaveBeenCalledWith('ssh-1')
    expect(state.ensureDetectedAgents).not.toHaveBeenCalled()
    expect(state.createWorktree).toHaveBeenCalled()
  })

  it('uses the active workspace repo over the active repo selection', async () => {
    const repoTwo: Repo = {
      ...localRepo,
      id: 'repo-2',
      path: '/repo-two',
      displayName: 'repo-two'
    }
    const state = makeState({
      activeRepoId: localRepo.id,
      activeWorktreeId: 'wt-active',
      repos: [localRepo, repoTwo],
      worktreesByRepo: {
        [repoTwo.id]: [{ id: 'wt-active', repoId: repoTwo.id, path: '/repo-two/worktrees/current' }]
      }
    })

    const openModalFallback = await runQuickCreate(state)

    expect(openModalFallback).not.toHaveBeenCalled()
    expect(state.createWorktree).toHaveBeenCalledWith(
      repoTwo.id,
      'quick-workspace',
      undefined,
      'inherit',
      undefined,
      'sidebar',
      undefined,
      undefined,
      undefined,
      undefined,
      'codex'
    )
  })

  it('quick-creates with setup skipped when the repo policy is skip-by-default', async () => {
    const state = makeState({
      repos: [
        {
          ...localRepo,
          hookSettings: {
            mode: 'auto',
            setupRunPolicy: 'skip-by-default',
            scripts: { setup: '', archive: '' }
          }
        }
      ]
    })
    vi.mocked(getSetupConfig).mockReturnValue({ source: 'yaml', command: 'pnpm install' })

    const openModalFallback = await runQuickCreate(state)

    expect(openModalFallback).not.toHaveBeenCalled()
    expect(state.createWorktree).toHaveBeenCalledWith(
      localRepo.id,
      'quick-workspace',
      undefined,
      'skip',
      undefined,
      'sidebar',
      undefined,
      undefined,
      undefined,
      undefined,
      'codex'
    )
  })
})
