// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { getDefaultSettings } from '../../../../shared/constants'
import { useOnboardingFlowActions } from './use-onboarding-flow-actions'
import { useCloseWith } from './use-onboarding-flow-persistence'
import { getDefaultOnboardingState } from '../../../../shared/onboarding-defaults'
import { STEPS } from './use-onboarding-flow-types'
import type { WorkspaceActivationOutcome } from '@/lib/worktree-activation-outcome'

const { track, launch, reveal, state, toastError, focusIntent } = vi.hoisted(() => ({
  track: vi.fn(),
  launch: vi.fn(),
  reveal: vi.fn<(...args: unknown[]) => WorkspaceActivationOutcome>(() => ({
    opened: { primaryTabId: null }
  })),
  state: { activeWorkspaceExecutionHostId: 'runtime:chosen' },
  toastError: vi.fn(),
  focusIntent: { cancel: vi.fn() }
}))
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => state.activeWorkspaceExecutionHostId
}))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTabWithOutcome: launch }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorkspaceWithOutcome: reveal }))
vi.mock('@/components/agent-tab-launch-context', () => ({
  captureAgentTabLaunchContext: () => ({ groupId: 'group', focusIntent })
}))
vi.mock('@/lib/telemetry', () => ({ track }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  state.activeWorkspaceExecutionHostId = 'runtime:chosen'
})

function renderActions(
  hasSelectedWorkspace: boolean,
  stepIndex = STEPS.length - 1,
  selectedAgent: TuiAgent | null = 'codex'
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
      settings: getDefaultSettings('/tmp'),
      persistCurrentStep,
      selectedWorkspaceId: hasSelectedWorkspace ? 'folder:home' : null,
      closeWith,
      openModal,
      getNextStepIndex: (index) => index + 1,
      onOnboardingChange,
      stepIndex,
      setStepIndex: vi.fn(),
      selectedAgent,
      themeStepEntryThemeRef: { current: null },
      setTheme: vi.fn(),
      updateSettings: vi.fn(),
      skipOptions: { skipIntegrations: true, skipWindowsTerminal: true }
    })
  })
  return { result, openModal, update, persistCurrentStep, onOnboardingChange }
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
      expect(onOnboardingChange).toHaveBeenCalledTimes(1)
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
    expect(toastError.mock.calls[0][0]).toContain('Claude')
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

  it('keeps explicit project setup even with a selected workspace', async () => {
    const { result, openModal } = renderActions(true, 0)
    await act(() => result.current.skipToRepo())
    expect(launch).not.toHaveBeenCalled()
    expect(openModal).toHaveBeenCalledWith('add-repo')
    expect(track).toHaveBeenCalledWith(
      'onboarding_completed',
      expect.objectContaining({ path: 'add_project_modal' })
    )
  })

  it('keeps onboarding open when completion cannot be saved', async () => {
    const { result, openModal, update, onOnboardingChange } = renderActions(true)
    update.mockRejectedValueOnce(new Error('save failed'))
    await act(() => result.current.next())
    expect(openModal).not.toHaveBeenCalled()
    expect(onOnboardingChange).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledExactlyOnceWith('Could not save progress')
    expect(track).not.toHaveBeenCalledWith('onboarding_completed', expect.anything())
    await act(() => result.current.next())
    expect(onOnboardingChange).toHaveBeenCalledTimes(1)
  })
  it('keeps the captured target and owner through saving, dispatching once after unmount', async () => {
    const { result, persistCurrentStep, onOnboardingChange } = renderActions(true)
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
    expect(persistCurrentStep).toHaveBeenCalledOnce()
    expect(onOnboardingChange).toHaveBeenCalledOnce()
    expect(launch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        worktreeId: 'folder:home',
        workspaceExecutionHostId: 'runtime:chosen'
      })
    )
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
