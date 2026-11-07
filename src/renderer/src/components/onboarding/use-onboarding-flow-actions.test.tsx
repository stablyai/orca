// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { getDefaultSettings } from '../../../../shared/constants'
import { useOnboardingFlowActions } from './use-onboarding-flow-actions'
import { useCloseWith } from './use-onboarding-flow-persistence'
import { getDefaultOnboardingState } from '../../../../shared/onboarding-defaults'
import { STEPS } from './use-onboarding-flow-types'
import type { WorkspaceActivationOutcome } from '@/lib/worktree-activation-outcome'

const {
  track,
  launch,
  reveal,
  state,
  toastError,
  focusIntent,
  detect,
  acquireChoices,
  preferences
} = vi.hoisted(() => {
  const state: { activeWorkspaceExecutionHostId: string; settings: GlobalSettings | null } = {
    activeWorkspaceExecutionHostId: 'runtime:chosen',
    settings: null
  }
  return {
    track: vi.fn(),
    launch: vi.fn(),
    reveal: vi.fn<(...args: unknown[]) => WorkspaceActivationOutcome>(() => ({
      opened: { primaryTabId: null }
    })),
    state,
    detect: vi.fn(),
    acquireChoices: vi.fn(),
    preferences: vi.fn(),
    toastError: vi.fn(),
    focusIntent: { cancel: vi.fn() }
  }
})
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('@/lib/workspace/ownership/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => state.activeWorkspaceExecutionHostId
}))
vi.mock('@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab', () => ({
  launchAgentInNewTabWithOutcome: launch
}))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorkspaceWithOutcome: reveal
}))
vi.mock('@/components/agent-tab-launch-context', () => ({
  captureAgentTabLaunchContext: () => ({ groupId: 'group', focusIntent })
}))
vi.mock('@/lib/telemetry', () => ({ track }))
vi.mock('@/lib/agent-detection-target-inventory', () => ({ loadDetectedAgentsForWorktree: detect }))
vi.mock('@/lib/host-chat-program-acquisition', () => ({
  acquireAgentLaunchChoices: acquireChoices
}))
vi.mock('@/runtime/agent-launch-settings/use-host-agent-launch-preferences', () => ({
  ensureAgentLaunchPreferences: preferences
}))
beforeEach(() => {
  state.settings = getDefaultSettings('/tmp')
  detect.mockResolvedValue(['claude', 'codex'])
  preferences.mockImplementation(async (store) => store.settings)
  acquireChoices.mockImplementation(async (_workspace, load) => ({ detected: await load() }))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  state.activeWorkspaceExecutionHostId = 'runtime:chosen'
})

function renderActions(
  hasSelectedWorkspace: boolean,
  stepIndex = STEPS.length - 1,
  selectedAgent: TuiAgent | null = 'codex',
  options: { surface?: 'chat' | 'terminal'; defaultAgent?: GlobalSettings['defaultTuiAgent'] } = {}
) {
  const openModal = vi.fn()
  const update = vi.fn().mockResolvedValue({
    ...getDefaultOnboardingState(),
    outcome: 'completed',
    closedAt: 1
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      onboarding: { update },
      starNag: { onboardingCompleted: vi.fn() }
    }
  })
  const onOnboardingChange = vi.fn()
  const persistCurrentStep = vi.fn().mockResolvedValue({ ok: true })
  state.settings = {
    ...getDefaultSettings('/tmp'),
    defaultTuiAgent: options.defaultAgent ?? null
  }
  const updateSettings = vi.fn(async (updates: Partial<GlobalSettings>) => {
    state.settings = { ...state.settings!, ...updates }
  })
  const { result } = renderHook(() => {
    const closeWith = useCloseWith({
      onOnboardingChange,
      startTimeRef: { current: 1 },
      setError: vi.fn()
    })
    return useOnboardingFlowActions({
      busyLabel: null,
      setBusyLabel: vi.fn(),
      setError: vi.fn(),
      currentStep: STEPS[stepIndex],
      consumeStepDurationMs: () => 10,
      trackTaskSourcesSnapshot: vi.fn(),
      settings: state.settings,
      persistCurrentStep,
      selectedWorkspaceId: hasSelectedWorkspace ? 'folder:home' : null,
      closeWith,
      openModal,
      getNextStepIndex: (index) => index + 1,
      onOnboardingChange,
      stepIndex,
      setStepIndex: vi.fn(),
      selectedAgent,
      agentSurface: options.surface ?? 'terminal',
      themeLookBaseline: null,
      setTheme: vi.fn(),
      updateSettings,
      skipOptions: { skipIntegrations: true, skipWindowsTerminal: true }
    })
  })
  return { result, openModal, update, persistCurrentStep, onOnboardingChange, updateSettings }
}

describe('onboarding completion destination', () => {
  it.each(['claude', 'codex'] as const)(
    'opens the requested %s in the selected workspace after close',
    async (agent) => {
      const { result, openModal, update, onOnboardingChange } = renderActions(
        true,
        STEPS.length - 1,
        agent
      )
      await act(() => result.current.next())
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'completed', lastCompletedStep: 5 })
      )
      expect(launch).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          agent,
          worktreeId: 'folder:home',
          workspaceExecutionHostId: 'runtime:chosen',
          launchSource: 'onboarding',
          groupId: 'group',
          focusIntent
        })
      )
      expect(onOnboardingChange.mock.invocationCallOrder[0]).toBeLessThan(
        launch.mock.invocationCallOrder[0]
      )
      launch.mock.calls[0][0].beforeSurfaceOpen()
      expect(reveal).toHaveBeenCalledWith(
        'folder:home',
        expect.objectContaining({
          agent,
          providesInitialSurface: true,
          executionHostId: 'runtime:chosen'
        })
      )
      expect(openModal).not.toHaveBeenCalled()
      expect(track).toHaveBeenCalledWith(
        'onboarding_completed',
        expect.objectContaining({ path: 'workspace' })
      )
    }
  )

  it('reports a captured workspace disappearing while completion is saved, without opening a surface', async () => {
    const { result, persistCurrentStep } = renderActions(true, STEPS.length - 1, 'claude')
    const saved = Promise.withResolvers<{ ok: boolean }>()
    persistCurrentStep.mockReturnValueOnce(saved.promise)
    let finishing: Promise<void>
    act(() => {
      finishing = result.current.next()
    })
    expect(launch).not.toHaveBeenCalled()
    reveal.mockReturnValueOnce({ refused: { reason: 'workspace-missing', failureNotified: false } })
    await act(async () => {
      saved.resolve({ ok: true })
      await finishing
    })
    const createSurface = vi.fn()
    if (launch.mock.calls[0][0].beforeSurfaceOpen()) {
      createSurface()
    }
    expect(createSurface).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledOnce()
  })

  it('retains Add Project when no workspace is selected', async () => {
    const { result, openModal } = renderActions(false)
    await act(() => result.current.next())
    expect(launch).not.toHaveBeenCalled()
    expect(openModal).toHaveBeenCalledWith('add-repo')
    expect(track).toHaveBeenCalledWith(
      'onboarding_completed',
      expect.objectContaining({ path: 'add_project_modal' })
    )
  })

  it.each([true, false])(
    'returns to the main page when setting up later, selected workspace=%s',
    async (hasSelectedWorkspace) => {
      const { result, openModal, update, updateSettings } = renderActions(
        hasSelectedWorkspace,
        STEPS.findIndex((step) => step.id === 'agent'),
        'claude'
      )
      await act(() => result.current.setUpLater())
      expect(updateSettings).toHaveBeenCalledWith({ defaultTuiAgent: 'claude' })
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'completed',
          lastCompletedStep: 5,
          checklist: { dismissed: false }
        })
      )
      expect(openModal).not.toHaveBeenCalled()
      if (hasSelectedWorkspace) {
        expect(launch).toHaveBeenCalledWith(
          expect.objectContaining({ agent: 'claude', worktreeId: 'folder:home' })
        )
      } else {
        expect(launch).not.toHaveBeenCalled()
      }
    }
  )

  it('keeps onboarding open for retry when setting up later cannot save completion', async () => {
    const { result, update, onOnboardingChange, openModal } = renderActions(
      true,
      STEPS.findIndex((step) => step.id === 'agent')
    )
    update.mockRejectedValueOnce(new Error('save failed'))
    await act(() => result.current.setUpLater())
    expect(onOnboardingChange).not.toHaveBeenCalled()
    expect(openModal).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
    await act(() => result.current.setUpLater())
    expect(openModal).not.toHaveBeenCalled()
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex' }))
  })

  it('does not leave onboarding when the skipped agent preference cannot be saved', async () => {
    const { result, updateSettings, update, onOnboardingChange, openModal } = renderActions(
      true,
      STEPS.findIndex((step) => step.id === 'agent')
    )
    updateSettings.mockRejectedValueOnce(new Error('settings save failed'))
    await act(() => result.current.setUpLater())
    expect(update).not.toHaveBeenCalled()
    expect(onOnboardingChange).not.toHaveBeenCalled()
    expect(openModal).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
    await act(() => result.current.setUpLater())
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex' }))
  })

  it('keeps onboarding open when completion cannot be saved', async () => {
    const { result, openModal, update, onOnboardingChange } = renderActions(true)
    update.mockRejectedValueOnce(new Error('save failed'))
    await act(() => result.current.next())
    expect(openModal).not.toHaveBeenCalled()
    expect(onOnboardingChange).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
    expect(track).not.toHaveBeenCalledWith('onboarding_completed', expect.anything())
    await act(() => result.current.next())
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex' }))
  })
  it('keeps the captured target and owner through saving, dispatching once after unmount', async () => {
    const { result, persistCurrentStep } = renderActions(true)
    const saved = Promise.withResolvers<{ ok: boolean }>()
    persistCurrentStep.mockReturnValueOnce(saved.promise)
    let finishing: Promise<void>
    act(() => {
      finishing = result.current.next()
    })
    await act(() => result.current.next())
    state.activeWorkspaceExecutionHostId = 'runtime:other'
    cleanup()
    await act(async () => {
      saved.resolve({ ok: true })
      await finishing
    })
    expect(launch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        worktreeId: 'folder:home',
        workspaceExecutionHostId: 'runtime:chosen'
      })
    )
  })

  it.each(['chat', 'terminal'] as const)(
    'confirms first-page %s mode and launches the saved agent instead of a hidden auto-pick',
    async (surface) => {
      const { result, openModal } = renderActions(true, 0, 'claude', {
        surface,
        defaultAgent: 'codex'
      })
      await act(() => result.current.setUpLater())
      expect(state.settings).toEqual(
        expect.objectContaining({
          agentDefaultSurface: surface,
          defaultTuiAgent: 'codex'
        })
      )
      expect(launch).toHaveBeenCalledWith(
        expect.objectContaining({ agent: 'codex', worktreeId: 'folder:home' })
      )
      expect(openModal).not.toHaveBeenCalled()
    }
  )

  it.each(['agent_surface', 'theme'] as const)(
    'preserves saved Blank on %s despite a hidden auto-pick',
    async (step) => {
      const { result } = renderActions(
        true,
        STEPS.findIndex((value) => value.id === step),
        'claude',
        {
          surface: 'chat',
          defaultAgent: 'blank'
        }
      )
      await act(() => result.current.setUpLater())
      expect(state.settings?.defaultTuiAgent).toBe('blank')
      expect(launch).not.toHaveBeenCalled()
    }
  )

  it('confirms a visible agent or Blank without substituting an installed agent', async () => {
    const agentPage = STEPS.findIndex((step) => step.id === 'agent')
    const chosen = renderActions(true, agentPage, 'aider', { defaultAgent: 'codex' })
    await act(() => chosen.result.current.setUpLater())
    expect(state.settings?.defaultTuiAgent).toBe('aider')
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ agent: 'aider' }))
    cleanup()
    launch.mockClear()
    const blank = renderActions(true, agentPage, null, { defaultAgent: 'codex' })
    await act(() => blank.result.current.setUpLater())
    expect(state.settings?.defaultTuiAgent).toBe('blank')
    expect(launch).not.toHaveBeenCalled()
  })

  it('resolves ordinary Auto without replacing the saved preference', async () => {
    const { result } = renderActions(true, 0, 'codex')
    await act(() => result.current.setUpLater())
    expect(state.settings?.defaultTuiAgent).toBeNull()
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ agent: 'claude' }))
  })

  it('retains the clicked workspace owner through deferred save and post-close discovery', async () => {
    const { result, updateSettings, onOnboardingChange } = renderActions(true, 0, 'claude', {
      surface: 'chat',
      defaultAgent: 'codex'
    })
    const saved = Promise.withResolvers<void>()
    const detected = Promise.withResolvers<string[]>()
    updateSettings.mockImplementationOnce(async (updates) => {
      await saved.promise
      state.settings = { ...state.settings!, ...updates }
    })
    detect.mockReturnValueOnce(detected.promise)
    const owners: string[] = []
    acquireChoices.mockImplementationOnce(
      async (_workspace, load, _signal, _deadline, getState) => {
        owners.push(getState().activeWorkspaceExecutionHostId)
        const ids = await load()
        owners.push(getState().activeWorkspaceExecutionHostId)
        return { detected: ids }
      }
    )
    let finishing: Promise<void>
    act(() => {
      finishing = result.current.setUpLater()
    })
    await act(() => result.current.next())
    await act(() => result.current.setUpLater())
    state.activeWorkspaceExecutionHostId = 'runtime:other'
    await act(async () => {
      saved.resolve()
      await saved.promise
    })
    expect(onOnboardingChange).toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
    cleanup()
    await act(async () => {
      detected.resolve(['codex'])
      await finishing
    })
    expect(owners).toEqual(['runtime:chosen', 'runtime:chosen'])
    expect(preferences).toHaveBeenCalledWith(
      expect.objectContaining({ activeWorkspaceExecutionHostId: 'runtime:chosen' }),
      expect.anything()
    )
    expect(launch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        agent: 'codex',
        worktreeId: 'folder:home',
        workspaceExecutionHostId: 'runtime:chosen'
      })
    )
  })

  it('settles a failed default lookup after closing without launching or reporting twice', async () => {
    const { result, onOnboardingChange } = renderActions(true, 0, 'claude')
    detect.mockRejectedValueOnce(new Error('owner retired'))
    await act(() => result.current.setUpLater())
    expect(onOnboardingChange).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'completed' })
    )
    expect(launch).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('does not launch for an unselected agent, dismissal or failed step persistence', async () => {
    const blank = renderActions(true, STEPS.length - 1, null)
    await act(() => blank.result.current.next())
    expect(launch).not.toHaveBeenCalled()
    cleanup()
    const dismissed = renderActions(true)
    await act(() => dismissed.result.current.dismissOnboarding())
    expect(launch).not.toHaveBeenCalled()
    cleanup()
    const failed = renderActions(true)
    failed.persistCurrentStep.mockResolvedValueOnce({ ok: false })
    await act(() => failed.result.current.next())
    expect(failed.update).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
  })
})
