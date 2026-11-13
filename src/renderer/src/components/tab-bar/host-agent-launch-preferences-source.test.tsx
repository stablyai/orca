// @vitest-environment happy-dom
import { rpc, server, status } from './new-tab-agent-menu-host-preferences-test-fixture'
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { AGENT_LAUNCH_CHOICES_CAPABILITY } from '../../../../shared/agent-launch/contracts/agent-launch-runtime-capability'
import {
  compatibilityEntry,
  rememberRuntimeEnvironmentCompatibility
} from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { useAppStore } from '@/store'
import { projectAgentLaunchSettings } from '../../../../shared/agent-launch/choices/agent-launch-settings'
import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY as CLIENT
} from '../../../../shared/agent-session/agent-session-runtime-capabilities'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { mutateHostAgentLaunchSettings } from '../../runtime/agent-launch-settings/agent-launch-settings-transport'
import {
  ensureAgentLaunchPreferences,
  readAgentLaunchPreferencesForWorktree
} from '../../runtime/agent-launch-settings/use-host-agent-launch-preferences'

import { useAgentMenuObservation } from './use-new-tab-agent-menu-rows'

it('projects one capable source through cold, deadline, late, failed-refresh and empty answers', async () => {
  vi.useFakeTimers()
  try {
    const desktop = { claude: { model: 'desktop', options: { effort: 'low' } } }
    useAppStore.setState((state) => ({
      settings: { ...state.settings!, agentLaunchChoices: desktop },
      runtimeStatusByEnvironmentId: new Map([
        [
          'alpha',
          {
            ...status(),
            status: {
              ...status().status!,
              capabilities: [CHAT, CLIENT, AGENT_LAUNCH_CHOICES_CAPABILITY]
            }
          }
        ]
      ])
    }))
    const read = () => readAgentLaunchPreferencesForWorktree(useAppStore.getState(), 'wt')
    const empty = read().agentLaunchChoices
    expect(empty).toEqual({})
    expect(read().agentLaunchChoices).toBe(empty)
    expect(rpc.call).not.toHaveBeenCalled()
    expect(rpc.supports).not.toHaveBeenCalled()
    const pending = Promise.withResolvers<{ settings: typeof server }>()
    rpc.call.mockReturnValueOnce(pending.promise)
    const menu = renderHook(() =>
      useAgentMenuObservation('wt', true, { kind: 'runtime', environmentId: 'alpha' })
    )
    const attempt = ensureAgentLaunchPreferences(useAppStore.getState(), {
      kind: 'git-worktree',
      worktreeId: 'wt'
    })
    expect(menu.result.current.preferences.agentLaunchChoices).toBe(empty)
    await act(async () => vi.advanceTimersByTimeAsync(3_000))
    await expect(attempt).resolves.toMatchObject({
      defaultTuiAgent: null,
      disabledTuiAgents: [],
      agentLaunchChoices: {},
      agentPermissionDefault: 'own'
    })
    expect(read()).toMatchObject(menu.result.current.preferences)
    useAppStore.setState((state) => ({
      settings: {
        ...state.settings!,
        agentDefaultArgs: { claude: '--verbose' },
        agentDefaultEnv: { claude: { KEEP: 'caller' } }
      },
      ensureRuntimeDetectedAgents: vi.fn().mockResolvedValue(['claude']),
      updateWorktreeMeta: vi.fn().mockResolvedValue(undefined)
    }))
    const { prepareQuickComposerStartup } =
      await import('@/hooks/composer-state/quick-startup-plan')
    const quick = await prepareQuickComposerStartup({
      agent: 'claude',
      repoId: TEST_REPO.id,
      executionHostId: 'runtime:alpha',
      linkedWorkItem: null,
      note: '',
      settings: useAppStore.getState().settings,
      launchHost: { kind: 'known', platform: 'linux', hostKind: 'runtime' },
      shell: 'posix',
      isRemote: true,
      telemetrySource: undefined
    })
    expect(quick.backendStartup).toMatchObject({
      command: expect.stringContaining("'--verbose'"),
      env: { KEEP: 'caller' },
      launchConfig: { agentArgs: '--dangerously-skip-permissions --verbose' }
    })
    expect(quick.startupPlan?.launchCommand).not.toContain('desktop')
    expect(quick.startupPlan?.launchCommand).not.toContain("'low'")
    const { prepareDirectWorkItemAgentLaunch } =
      await import('@/lib/workspace/creation/work-item/launch-work-item-direct-route-preparation')
    const { planAgentSessionLaunch } =
      await import('@/lib/agent-session/launch/routing/agent-session-launch-plan')
    const direct = await prepareDirectWorkItemAgentLaunch({
      worktreeId: 'wt',
      worktreePath: '/repo',
      repoId: TEST_REPO.id,
      agentOverride: 'claude',
      repoConnectionId: null,
      repoHost: TEST_REPO,
      latestStore: useAppStore.getState(),
      draftContent: 'draft task',
      promptDelivery: 'draft',
      repoLaunchHost: { kind: 'known', platform: 'linux', hostKind: 'runtime' },
      planLaunch: planAgentSessionLaunch,
      requestId: 'c4-direct'
    })
    expect(direct.startupPlan).toMatchObject({
      env: { KEEP: 'caller' },
      launchConfig: { agentArgs: '--dangerously-skip-permissions --verbose' }
    })
    expect(direct.startupPlan?.launchCommand).not.toContain('desktop')
    expect(direct.startupPlan?.launchCommand).not.toContain("'low'")
    expect(rpc.call).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve({ settings: server }))
    expect(read()).toMatchObject(menu.result.current.preferences)
    expect(read().agentLaunchChoices).toEqual(server.agentChoices?.defaults)
    const next = await prepareQuickComposerStartup({
      agent: 'codex',
      repoId: TEST_REPO.id,
      executionHostId: 'runtime:alpha',
      linkedWorkItem: null,
      note: '',
      settings: useAppStore.getState().settings,
      launchHost: { kind: 'known', platform: 'linux', hostKind: 'runtime' },
      shell: 'posix',
      isRemote: true,
      telemetrySource: undefined
    })
    expect(next.backendStartup?.command).toContain('host-model')
    expect(next.backendStartup?.command).toContain('low')
    rpc.call.mockRejectedValueOnce(new Error('offline'))
    await act(async () =>
      useAppStore.setState((state) => ({
        runtimeStatusByEnvironmentId: new Map(state.runtimeStatusByEnvironmentId).set('alpha', {
          ...status(),
          hostContactEpoch: 2
        })
      }))
    )
    expect(read().agentLaunchChoices).toEqual(server.agentChoices?.defaults)
    expect(menu.result.current.preferences.agentLaunchChoices).toEqual(
      server.agentChoices?.defaults
    )
    rpc.call.mockResolvedValue({ settings: projectAgentLaunchSettings({ agentLaunchChoices: {} }) })
    await act(async () =>
      mutateHostAgentLaunchSettings(
        { environmentId: 'alpha', pairingRevision: 7 },
        { type: 'availability', agent: 'claude', enabled: true }
      )
    )
    expect(read().agentLaunchChoices).toEqual({})
    expect(menu.result.current.preferences.agentLaunchChoices).toEqual({})
    expect(useAppStore.getState().settings?.agentLaunchChoices).toBe(desktop)
  } finally {
    vi.useRealTimers()
  }
})

it('updates the shared cold projection when existing capability resolves after the fallback deadline', async () => {
  vi.useFakeTimers()
  try {
    const desktop = { claude: { options: { effort: 'low' } } }
    useAppStore.setState((state) => ({
      settings: { ...state.settings!, agentLaunchChoices: desktop }
    }))
    const capability = Promise.withResolvers<void>()
    rpc.supports.mockImplementation(async () => {
      await capability.promise
      rememberRuntimeEnvironmentCompatibility(
        'alpha',
        compatibilityEntry({ ...status().status!, capabilities: [AGENT_LAUNCH_CHOICES_CAPABILITY] })
      )
      return true
    })
    const settings = Promise.withResolvers<{ settings: typeof server }>()
    rpc.call.mockReturnValueOnce(settings.promise)
    const menu = renderHook(() =>
      useAgentMenuObservation('wt', true, { kind: 'runtime', environmentId: 'alpha' })
    )
    const read = () => readAgentLaunchPreferencesForWorktree(useAppStore.getState(), 'wt')
    await act(async () => vi.advanceTimersByTimeAsync(3_000))
    expect(menu.result.current.preferencesPending).toBe(false)
    expect(menu.result.current.preferences.agentLaunchChoices).toEqual({})
    await act(async () => capability.resolve())
    expect(menu.result.current.preferences.agentLaunchChoices).toEqual({})
    expect(read().agentLaunchChoices).toBe(menu.result.current.preferences.agentLaunchChoices)
    await expect(
      ensureAgentLaunchPreferences(useAppStore.getState(), {
        kind: 'git-worktree',
        worktreeId: 'wt'
      })
    ).resolves.toEqual(read())
    expect(rpc.call).toHaveBeenCalledTimes(1)
    await act(async () => settings.resolve({ settings: server }))
    expect(read().agentLaunchChoices).toEqual(server.agentChoices?.defaults)
    await act(async () =>
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map([
          [
            'alpha',
            {
              ...status(),
              snapshot: {
                environmentId: 'alpha',
                pairingRevision: 7,
                sequence: 2,
                checkedAt: 1,
                status: status().status,
                verification: 'unavailable',
                transport: 'disconnected',
                retired: true
              }
            }
          ]
        ])
      })
    )
    expect(read().agentLaunchChoices).toEqual({})
    expect(menu.result.current.preferences.agentLaunchChoices).toEqual({})
    expect(useAppStore.getState().settings?.agentLaunchChoices).toBe(desktop)
  } finally {
    vi.useRealTimers()
  }
})

it('applies the owning project defaults to workspace preferences and new-tab menus', async () => {
  useAppStore.setState((state) => ({
    repos: [
      {
        ...TEST_REPO,
        agentLaunchDefaults: {
          defaultTuiAgent: 'opencode',
          agentLaunchChoices: { codex: { model: 'desktop-project' } }
        }
      },
      {
        ...TEST_REPO,
        executionHostId: 'runtime:alpha',
        agentLaunchDefaults: {
          defaultTuiAgent: 'claude',
          agentLaunchChoices: { codex: { model: 'remote-project', options: { effort: 'high' } } }
        }
      }
    ],
    settings: { ...state.settings!, agentLaunchChoices: { codex: { model: 'desktop-global' } } }
  }))
  const workspace = { kind: 'git-worktree' as const, worktreeId: 'wt' }
  const ensured = await ensureAgentLaunchPreferences(useAppStore.getState(), workspace)
  expect(ensured.defaultTuiAgent).toBe('claude')
  expect(ensured.agentLaunchChoices?.codex).toEqual({
    model: 'remote-project',
    options: { effort: 'high' }
  })
  const menu = renderHook(() =>
    useAgentMenuObservation('wt', true, { kind: 'runtime', environmentId: 'alpha' })
  )
  expect(menu.result.current.preferences.defaultTuiAgent).toBe('claude')
  expect(menu.result.current.preferences.agentLaunchChoices?.codex).toEqual({
    model: 'remote-project',
    options: { effort: 'high' }
  })
  await act(async () =>
    useAppStore.setState((state) => ({
      repos: state.repos.map((repo) =>
        repo.executionHostId === 'runtime:alpha'
          ? { ...repo, agentLaunchDefaults: undefined }
          : repo
      )
    }))
  )
  expect(
    readAgentLaunchPreferencesForWorktree(useAppStore.getState(), 'wt').agentLaunchChoices?.codex
  ).toEqual({ model: 'host-model', options: { effort: 'low' } })
  expect(menu.result.current.preferences.defaultTuiAgent).toBe('codex')
})
