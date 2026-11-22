// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import { useOnboardingFlowActions } from './use-onboarding-flow-actions'
import { STEPS } from './use-onboarding-flow-types'
import type * as OnboardingFlowState from './onboarding-flow-state'

const { prepareSkipped } = vi.hoisted(() => ({ prepareSkipped: vi.fn() }))
vi.mock('./onboarding-flow-state', async (original) => ({
  ...(await original<typeof OnboardingFlowState>()),
  prepareSkippedOnboardingPreferences: prepareSkipped
}))

it('blocks dismissal while skipped choices save and releases it when the save fails', async () => {
  let finishSave: (saved: boolean) => void = () => {}
  prepareSkipped.mockImplementationOnce(() => new Promise<boolean>((done) => (finishSave = done)))
  const closeWith = vi.fn(async () => true)
  const { result } = renderHook(() =>
    useOnboardingFlowActions({
      busyLabel: null,
      setBusyLabel: vi.fn(),
      setError: vi.fn(),
      currentStep: STEPS.find((step) => step.id === 'agent')!,
      consumeStepDurationMs: () => 10,
      trackTaskSourcesSnapshot: vi.fn(),
      settings: getDefaultSettings('/tmp'),
      persistCurrentStep: vi.fn(async () => ({ ok: true as const })),
      selectedWorkspaceId: null,
      opensAddProject: true,
      closeWith,
      openModal: vi.fn(),
      getNextStepIndex: (index) => index + 1,
      onOnboardingChange: vi.fn(),
      stepIndex: STEPS.findIndex((step) => step.id === 'agent'),
      setStepIndex: vi.fn(),
      selectedAgent: 'claude',
      agentSurface: 'terminal',
      themeLookBaseline: null,
      setTheme: vi.fn(),
      updateSettings: vi.fn()
    })
  )

  let leaving: Promise<void> = Promise.resolve()
  act(() => {
    leaving = result.current.setUpLater()
  })
  await expect(act(() => result.current.dismissOnboarding('keyboard'))).resolves.toBe(false)
  expect(closeWith).not.toHaveBeenCalled()

  await act(async () => {
    finishSave(false)
    await leaving
  })
  await expect(act(() => result.current.dismissOnboarding('keyboard'))).resolves.toBe(true)
  expect(closeWith).toHaveBeenCalledWith('dismissed', expect.any(Number), undefined, {
    durationMs: expect.any(Number),
    advancedVia: 'keyboard'
  })
})
