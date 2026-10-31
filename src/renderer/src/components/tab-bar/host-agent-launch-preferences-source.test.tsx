// @vitest-environment happy-dom
import {
  rpc,
  server,
  compositions,
  status
} from './new-tab-agent-menu-host-preferences-test-fixture'
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import {
  AGENT_LAUNCH_CHOICES_CAPABILITY,
  AGENT_LAUNCH_SETTINGS_CAPABILITY
} from '../../../../shared/agent-launch-runtime-capability'
import {
  compatibilityEntry,
  rememberRuntimeEnvironmentCompatibility
} from '@/runtime/runtime-compatibility-cache'
import { useAppStore } from '@/store'
import { projectAgentLaunchSettings } from '../../../../shared/agent-launch-settings'
import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY as CLIENT
} from '../../../../shared/protocol-version'
import { TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { mutateHostAgentLaunchSettings } from '../settings/agent-launch-settings-transport'
import {
  ensureAgentLaunchPreferences,
  readAgentLaunchPreferencesForWorktree
} from '../settings/use-host-agent-launch-preferences'
import { useAgentLaunchPickerInventory } from '../agent/use-agent-launch-picker-inventory'
import { useAgentMenuObservation, useNewTabAgentMenuRows } from './use-new-tab-agent-menu-rows'

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
    await expect(attempt).resolves.toEqual({
      defaultTuiAgent: 'opencode',
      disabledTuiAgents: ['codex'],
      agentLaunchChoices: empty
    })
    expect(menu.result.current.preferences).toEqual(read())
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
      await import('@/lib/launch-work-item-direct-route-preparation')
    const { planAgentSessionLaunch } = await import('@/lib/agent-session-launch-plan')
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
    expect(menu.result.current.preferences).toEqual(read())
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

it.each(['failed-capable', 'old-choices', 'old-settings', 'unknown'] as const)(
  'preserves capability-specific fallback and existing availability for %s',
  async (mode) => {
    const desktop = { claude: { model: 'desktop', options: { effort: 'low' } } }
    useAppStore.setState((state) => ({
      settings: { ...state.settings!, agentLaunchChoices: desktop }
    }))
    if (mode === 'failed-capable') {
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map([
          [
            'alpha',
            {
              ...status(),
              status: { ...status().status!, capabilities: [AGENT_LAUNCH_CHOICES_CAPABILITY] }
            }
          ]
        ])
      })
      rpc.call.mockRejectedValue(new Error('offline'))
    } else {
      rpc.supports.mockImplementation(
        async (_environment, capability) =>
          mode === 'old-choices' && capability === AGENT_LAUNCH_SETTINGS_CAPABILITY
      )
    }
    const read = () => readAgentLaunchPreferencesForWorktree(useAppStore.getState(), 'wt')
    expect(read().agentLaunchChoices).toEqual(mode === 'failed-capable' ? {} : desktop)
    expect(rpc.supports).not.toHaveBeenCalled()
    if (mode === 'unknown') {
      rpc.supports.mockImplementation(async () => {
        rememberRuntimeEnvironmentCompatibility(
          'alpha',
          compatibilityEntry({
            ...status().status!,
            capabilities: [AGENT_LAUNCH_CHOICES_CAPABILITY]
          })
        )
        return true
      })
      rpc.call.mockRejectedValue(new Error('offline'))
    }
    const hook = renderHook(() =>
      useAgentMenuObservation('wt', true, { kind: 'runtime', environmentId: 'alpha' })
    )
    const resolved = await ensureAgentLaunchPreferences(useAppStore.getState(), {
      kind: 'git-worktree',
      worktreeId: 'wt'
    })
    await act(async () => {})
    expect(resolved).toEqual(read())
    expect(hook.result.current.preferences).toEqual(read())
    expect(resolved.agentLaunchChoices).toEqual(
      mode === 'failed-capable' || mode === 'unknown' ? {} : desktop
    )
    expect(resolved.defaultTuiAgent).toBe(mode === 'old-choices' ? 'codex' : 'opencode')
    expect(useAppStore.getState().settings?.agentLaunchChoices).toBe(desktop)
  }
)

it.each([20, 200])(
  'bounds capable fallback subscriptions and independent work for %i holders',
  async (count) => {
    vi.useFakeTimers()
    const route = await import('@/lib/agent-launch-route-input')
    const builder = vi.spyOn(route, 'buildAgentLaunchRouteInput')
    const profiles = vi.spyOn(
      await import('../../../../shared/agent-launch-profile'),
      'projectAgentLaunchProfile'
    )
    try {
      const pending = Promise.withResolvers<{ settings: typeof server }>()
      rpc.call.mockReturnValueOnce(pending.promise)
      useAppStore.setState((state) => ({
        settings: {
          ...state.settings!,
          agentLaunchChoices: { claude: { options: { effort: 'low' } } }
        },
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
      let renders = 0
      const holders = Array.from({ length: count }, () =>
        renderHook(() => {
          const menu = useNewTabAgentMenuRows('wt', true, {
            kind: 'runtime',
            environmentId: 'alpha'
          })
          renders++
          return useAgentLaunchPickerInventory('wt', menu, false)
        })
      )
      await act(async () => vi.advanceTimersByTimeAsync(3_000))
      expect(rpc.call).toHaveBeenCalledTimes(1)
      expect(rpc.supports).toHaveBeenCalledTimes(2)
      expect(profiles.mock.calls.length).toBeLessThanOrEqual(12 * count)
      expect(builder.mock.calls.length).toBeLessThanOrEqual(20 * count)
      const work = {
        reads: rpc.call.mock.calls.length,
        status: rpc.supports.mock.calls.length,
        profiles: profiles.mock.calls.length,
        compositions: compositions.mock.calls.length,
        routes: builder.mock.calls.length,
        renders
      }
      await act(async () =>
        useAppStore.setState((state) => ({
          settings: { ...state.settings!, terminalFontSize: 19 }
        }))
      )
      expect(renders).toBe(work.renders)
      await act(async () =>
        useAppStore.setState((state) => ({
          runtimeStatusByEnvironmentId: new Map(state.runtimeStatusByEnvironmentId).set(
            'beta',
            status('other')
          )
        }))
      )
      expect(renders).toBe(work.renders)
      await act(async () =>
        useAppStore.setState((state) => ({
          settings: { ...state.settings!, agentLaunchChoices: { claude: { model: 'unused' } } }
        }))
      )
      expect(renders).toBe(work.renders)
      expect(rpc.call).toHaveBeenCalledTimes(work.reads)
      expect(rpc.supports).toHaveBeenCalledTimes(work.status)
      expect(profiles).toHaveBeenCalledTimes(work.profiles)
      expect(compositions).toHaveBeenCalledTimes(work.compositions)
      // Store selectors inspect the selected host once per holder, without rebuilding profiles/resources.
      expect(builder.mock.calls.length - work.routes).toBeLessThanOrEqual(3 * count)
      await act(async () => pending.resolve({ settings: server }))
      expect(renders).toBeGreaterThan(work.renders)
      expect(holders[0].result.current[0]?.ownerKey).not.toBeUndefined()
      expect(
        readAgentLaunchPreferencesForWorktree(useAppStore.getState(), 'wt').agentLaunchChoices
      ).toEqual(server.agentChoices?.defaults)
      holders.forEach((holder) => holder.unmount())
    } finally {
      vi.useRealTimers()
      builder.mockRestore()
      profiles.mockRestore()
    }
  }
)

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
    expect(menu.result.current.preferences.agentLaunchChoices).toBe(desktop)
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
    expect(read().agentLaunchChoices).toBe(desktop)
    expect(menu.result.current.preferences.agentLaunchChoices).toBe(desktop)
    expect(useAppStore.getState().settings?.agentLaunchChoices).toBe(desktop)
  } finally {
    vi.useRealTimers()
  }
})
