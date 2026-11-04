// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useOnboardingFlowActions } from './use-onboarding-flow-actions'
import { useCloseWith } from './use-onboarding-flow-persistence'
import { getDefaultOnboardingState } from '../../../../shared/onboarding-defaults'
import { STEPS } from './use-onboarding-flow-types'

const track = vi.hoisted(() => vi.fn())
vi.mock('@/lib/telemetry', () => ({ track }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderActions(hasSelectedWorkspace: boolean, stepIndex = STEPS.length - 1) {
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
      hasSelectedWorkspace,
      closeWith,
      openModal,
      getNextStepIndex: (index) => index + 1,
      onOnboardingChange,
      stepIndex,
      setStepIndex: vi.fn(),
      selectedAgent: 'codex',
      themeStepEntryThemeRef: { current: null },
      setTheme: vi.fn(),
      updateSettings: vi.fn(),
      skipOptions: { skipIntegrations: true, skipWindowsTerminal: true }
    })
  })
  return { result, openModal, update, persistCurrentStep, onOnboardingChange }
}

describe('onboarding completion destination', () => {
  it('closes into the selected workspace and reports that destination', async () => {
    const { result, openModal, update, onOnboardingChange } = renderActions(true)
    await act(() => result.current.next())
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'completed', lastCompletedStep: 5 })
    )
    expect(onOnboardingChange).toHaveBeenCalledTimes(1)
    expect(openModal).not.toHaveBeenCalled()
    expect(track).toHaveBeenCalledWith(
      'onboarding_completed',
      expect.objectContaining({ path: 'workspace' })
    )
  })

  it('retains Add Project when no workspace is selected', async () => {
    const { result, openModal } = renderActions(false)
    await act(() => result.current.next())
    expect(openModal).toHaveBeenCalledWith('add-repo')
    expect(track).toHaveBeenCalledWith(
      'onboarding_completed',
      expect.objectContaining({ path: 'add_project_modal' })
    )
  })

  it('keeps explicit project setup even with a selected workspace', async () => {
    const { result, openModal } = renderActions(true, 0)
    await act(() => result.current.skipToRepo())
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
    expect(track).not.toHaveBeenCalledWith('onboarding_completed', expect.anything())
    await act(() => result.current.next())
    expect(onOnboardingChange).toHaveBeenCalledTimes(1)
  })
})
