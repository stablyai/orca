// @vitest-environment happy-dom
import { act, cleanup, fireEvent, renderHook, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { getDefaultSourceControlAiSettings } from '../../../shared/source-control-ai-settings'
import { getDefaultSettings } from '../../../shared/constants'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT } from '../../../shared/protocol-version'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { useAvailableStatusBarToggles } from '@/components/status-bar/use-available-status-bar-toggles'
import { buildDashboardWorktreeLaunchOptions } from '@/components/dashboard/dashboard-worktree-launch-options'
import { resolveTerminalAgentTabShortcut } from '@/components/terminal-agent-tab-shortcut'
import { resolveQuickWorkspaceAgentSelection } from './quick-workspace-agent-selection'
import { startFixChecksAgent } from './fix-checks-agent-launch'
import { resolveChecksActionAgent } from './source-control-agent-picker'
import { declinedTerminalCanOpen } from './structured-agent-session-launch-admission'
import { launchAgentSessionContinuation } from './launch-agent-session-continuation'
import { renderCard, unmountCard } from '@/components/NewWorkspaceComposerCard.test-fixture'
import { useNewTabAgentMenuRows } from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import { TooltipProvider } from '@/components/ui/tooltip'
import { resetRendererAppPlatformCacheForTests } from './renderer-app-platform'
import { resolveDirectWorkItemAgent } from './launch-work-item-direct-agent-routing'
import type { Repo } from '../../../shared/repo-types'

const direct = vi.hoisted(() => vi.fn().mockResolvedValue(true))
vi.mock('./launch-work-item-direct', () => ({ launchWorkItemDirect: direct }))
vi.mock('./worktree-activation', () => ({ activateAndRevealWorktree: () => true }))
vi.mock('./focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: () => {} }))
const launch = vi.hoisted(() => vi.fn())
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: launch }))
vi.mock('@/components/contextual-tours/use-contextual-tour', () => ({
  useContextualTour: () => {}
}))
const initial = useAppStore.getInitialState()
const worktree = makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id })
const detectAgents = vi.fn()
beforeEach(async () => {
  useAppStore.setState(initial, true)
  useAppStore.getState().clearLocalDetectedAgents()
  resetRendererAppPlatformCacheForTests()
  setLocalRuntimeCapabilitiesForTests([CHAT])
  detectAgents.mockReset().mockRejectedValue(new Error('login environment unavailable'))
  launch.mockReset().mockReturnValue({ surface: { kind: 'local-terminal', tabId: 'continued' } })
  Object.assign(window, {
    api: {
      platform: { get: () => ({ platform: 'darwin' }) },
      preflight: { detectAgents },
      runtime: { getStatus: vi.fn(async () => ({ capabilities: [CHAT] })) }
    }
  })
  useAppStore.setState({
    repos: [TEST_REPO],
    worktreesByRepo: { [TEST_REPO.id]: [worktree] },
    activeRepoId: TEST_REPO.id,
    activeWorktreeId: worktree.id,
    settings: {
      ...getDefaultSettings('/tmp'),
      defaultTuiAgent: 'claude',
      agentDefaultSurface: 'chat'
    }
  })
  await useAppStore.getState().ensureDetectedAgents(worktree.id)
  expect(useAppStore.getState().readLocalAgentInventory(worktree.id)).toEqual({
    ids: null,
    state: 'failed'
  })
})
afterEach(() => {
  cleanup()
  setLocalRuntimeCapabilitiesForTests(null)
  useAppStore.getState().clearLocalDetectedAgents()
  useAppStore.setState(initial, true)
})

it('cold rejection preserves status controls, explicit composer submit, and truthful dashboard choices', async () => {
  const ids = useAppStore.getState().detectedAgentIds
  const toggles = [{ id: 'claude' }, { id: 'codex' }] as const
  const hook = renderHook(() => useAvailableStatusBarToggles(toggles))
  expect(hook.result.current).toEqual(toggles)
  const menu = renderHook(() => useNewTabAgentMenuRows(worktree.id, true, { kind: 'local' }))
  await act(async () => {})
  const model = menu.result.current
  expect(model.state).toBe('settled')
  if (model.state !== 'settled') {
    throw new Error('Agent menu did not settle after cold inventory rejection')
  }
  expect(model.detection).toMatchObject({ detectedIds: null, detectionFailed: true })
  expect(
    buildDashboardWorktreeLaunchOptions(
      useAppStore.getState(),
      [],
      [
        {
          worktreeId: worktree.id,
          repoId: TEST_REPO.id,
          repoName: 'Repo',
          worktreeName: 'Feature',
          hostKind: 'local',
          executionHostId: 'local',
          workspaceKind: 'worktree'
        }
      ]
    )
  ).toEqual({ [worktree.id]: [] })
  const selection = resolveQuickWorkspaceAgentSelection({
    quickAgentOverride: 'codex',
    preferredQuickAgent: 'claude',
    detectedAgentIds: ids
  })
  const submitted = vi.fn()
  const card = await renderCard(
    {
      quickAgent: selection.quickAgent,
      detectedAgentIds: ids === null ? null : new Set(ids),
      repoId: TEST_REPO.id,
      onCreate: () => submitted(selection.quickAgent)
    },
    TooltipProvider
  )
  await act(async () => {
    fireEvent.click(within(card).getByRole('button', { name: 'Create workspace' }))
  })
  expect(submitted).toHaveBeenCalledExactlyOnceWith('codex')
  unmountCard(card)
})

it('cold rejection settles saved/default Checks, both shortcut kinds and supported continuation/fallback', async () => {
  const state = useAppStore.getState()
  const workspace = {
    kind: 'git-worktree',
    repoId: TEST_REPO.id,
    executionHostId: 'local'
  } as const
  expect(resolveChecksActionAgent(state, 'fixChecks', TEST_REPO.id, workspace, null)).toBe('claude')
  useAppStore.setState({
    settings: {
      ...state.settings!,
      sourceControlAi: {
        ...getDefaultSourceControlAiSettings(),
        actions: { fixChecks: { agentId: 'codex' } }
      }
    }
  })
  expect(
    resolveChecksActionAgent(useAppStore.getState(), 'fixChecks', TEST_REPO.id, workspace, null)
  ).toBe('codex')
  const shortcut = (action: string) =>
    resolveTerminalAgentTabShortcut({
      activeWorktreeId: worktree.id,
      keybindings: { 'tab.newAgent.codex': ['Mod+Alt+1'] },
      matchShortcut: (id) => id === action
    })
  const defaultShortcut = shortcut('tab.newAgent')
  expect(defaultShortcut.agent ?? (await defaultShortcut.pendingAgent)).toBe('claude')
  expect(shortcut('tab.newAgent.codex')).toMatchObject({
    agent: 'codex',
    actionId: 'tab.newAgent.codex'
  })
  expect(declinedTerminalCanOpen('codex', worktree.id, 'local')).toBe(true)
  await expect(
    launchAgentSessionContinuation({
      agent: 'claude',
      worktreeId: worktree.id,
      prompt: 'Continue this task',
      launchSource: 'sidebar',
      launchChoice: {
        agent: 'claude',
        route: 'structured-native-chat',
        executionHostId: 'local'
      }
    })
  ).resolves.toBe(true)
  expect(launch).toHaveBeenCalledOnce()
  expect(launch).toHaveBeenCalledWith(
    expect.objectContaining({
      prompt: 'Continue this task',
      agentSessionLaunchPlan: expect.objectContaining({ route: 'structured-native-chat' })
    })
  )
})

it.each(['failed', 'empty', 'disabled', 'retargeted'] as const)(
  'direct explicit terminal admission uses the actual attempted context outcome: %s',
  async (outcome) => {
    useAppStore.getState().clearLocalDetectedAgents()
    Object.assign(window.api, { platform: { get: () => ({ platform: 'win32' }) } })
    resetRendererAppPlatformCacheForTests()
    const settings = {
      ...getDefaultSettings('/tmp'),
      agentDefaultSurface: 'terminal' as const,
      localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' } as const,
      disabledTuiAgents: outcome === 'disabled' ? ['claude' as const] : []
    }
    useAppStore.setState({ settings })
    detectAgents.mockImplementation(async () => {
      if (outcome === 'empty') {
        return []
      }
      if (outcome === 'retargeted') {
        useAppStore.setState({
          settings: { ...settings, localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Debian' } }
        })
      }
      throw new Error('optional inventory failed')
    })
    const repo: Repo = { ...TEST_REPO }
    const { store, ...result } = await resolveDirectWorkItemAgent({
      latestStore: useAppStore.getState(),
      agentOverride: 'claude',
      worktreeId: worktree.id,
      repoHost: repo
    })
    expect(result).toEqual({ agent: 'claude', unavailable: outcome !== 'failed' })
    expect(store).toBe(useAppStore.getState())
    expect(useAppStore.getState().readLocalAgentInventory(worktree.id).state).toBe(
      outcome === 'empty' ? 'successful' : outcome === 'retargeted' ? 'pending' : 'failed'
    )
  }
)

it.each(['failed', 'retained', 'empty', 'disabled', 'retargeted', 'missing'] as const)(
  'both early Checks arms preserve only the current explicit command: %s',
  async (outcome) => {
    for (const prospective of [false, true]) {
      direct.mockClear()
      launch.mockClear()
      useAppStore.getState().clearLocalDetectedAgents()
      const settings = {
        ...getDefaultSettings('/tmp'),
        agentDefaultSurface: 'terminal' as const,
        defaultTuiAgent: 'blank' as const,
        disabledTuiAgents: outcome === 'disabled' ? ['claude' as const] : [],
        sourceControlAi: {
          ...getDefaultSourceControlAiSettings(),
          actions: {
            fixChecks: {
              agentId: 'claude' as const,
              agentArgs: '--verbose',
              commandInputTemplate: 'repair {basePrompt}'
            }
          }
        }
      }
      useAppStore.setState({
        settings,
        repos: [TEST_REPO],
        worktreesByRepo: { [TEST_REPO.id]: [worktree] }
      })
      detectAgents.mockReset().mockRejectedValue(new Error('capture failed'))
      if (outcome === 'empty') {
        detectAgents.mockResolvedValue([])
      }
      if (outcome === 'retained') {
        detectAgents.mockResolvedValueOnce(['codex'])
        await useAppStore.getState().ensureDetectedAgents()
        Object.assign(window.api.preflight, {
          refreshAgents: vi.fn().mockRejectedValue(new Error('refresh failed'))
        })
        await useAppStore.getState().refreshDetectedAgents()
      }
      const held = Promise.withResolvers<string[]>()
      if (outcome === 'retargeted') {
        Object.assign(window.api, { platform: { get: () => ({ platform: 'win32' }) } })
        resetRendererAppPlatformCacheForTests()
        useAppStore.setState({
          settings: { ...settings, localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' } }
        })
        detectAgents.mockReturnValue(held.promise)
      }
      if (outcome === 'missing') {
        useAppStore.setState({ repos: [], worktreesByRepo: {} })
      }
      const starting = startFixChecksAgent({
        repoId: TEST_REPO.id,
        worktreeId: prospective ? null : worktree.id,
        basePrompt: 'checks',
        launchSource: 'task_page',
        ...(prospective
          ? {
              item: {
                id: 'pr-1',
                repoId: TEST_REPO.id,
                type: 'pr' as const,
                number: 1,
                title: 'Checks',
                state: 'open' as const,
                url: 'https://example.test/pr/1',
                labels: [],
                updatedAt: '',
                author: null
              },
              openModalFallback: vi.fn()
            }
          : {})
      })
      if (outcome === 'retargeted') {
        await Promise.resolve()
        expect(launch).not.toHaveBeenCalled()
        expect(direct).not.toHaveBeenCalled()
        useAppStore.setState({
          settings: { ...settings, localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Debian' } }
        })
        held.reject(new Error('old Ubuntu capture failed'))
      }
      const admitted = outcome === 'failed' || outcome === 'retained'
      expect(await starting).toBe(admitted)
      const boundary = prospective ? direct : launch
      if (admitted) {
        expect(boundary).toHaveBeenCalledOnce()
        expect(boundary.mock.calls[0]?.[0]).toMatchObject(
          prospective
            ? {
                agentOverride: 'claude',
                agentArgs: '--verbose',
                item: { pasteContent: 'repair checks' }
              }
            : {
                agent: 'claude',
                worktreeId: worktree.id,
                prompt: 'repair checks',
                agentArgs: '--dangerously-skip-permissions --verbose'
              }
        )
        expect(useAppStore.getState().readLocalAgentInventory().state).toBe('failed')
      } else {
        expect(boundary).not.toHaveBeenCalled()
      }
      Object.assign(window.api, { platform: { get: () => ({ platform: 'darwin' }) } })
      resetRendererAppPlatformCacheForTests()
    }
  }
)
