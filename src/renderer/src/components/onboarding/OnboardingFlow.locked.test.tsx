// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultOnboardingState } from '../../../../shared/onboarding-defaults'
import OnboardingFlow from './OnboardingFlow'
import type * as FlowTypes from './use-onboarding-flow-types'

const flowState = vi.hoisted(() => ({ locked: false }))
vi.mock('./use-onboarding-flow', async () => {
  const { STEPS } = await vi.importActual<typeof FlowTypes>('./use-onboarding-flow-types')
  return {
    useOnboardingFlow: () => ({
      currentStep: STEPS.find((step) => step.id === 'theme'),
      stepIndex: 2,
      busyLabel: null,
      locked: flowState.locked,
      agentSurface: 'terminal',
      progressSteps: STEPS.map((step, index) => ({ step, index })).filter(
        ({ step }) => step.id !== 'agent_surface'
      ),
      progressStepIndex: 1,
      hasSelectedWorkspace: false,
      settings: null,
      next: vi.fn(),
      back: vi.fn(),
      setUpLater: vi.fn(),
      dismissOnboarding: vi.fn(async () => true),
      jumpToStep: vi.fn(),
      setLifecycleRootRef: vi.fn()
    })
  }
})
vi.mock('@/store', () => ({ useAppStore: () => true }))
vi.mock('./OnboardingLanguageSwitcher', () => ({ OnboardingLanguageSwitcher: () => null }))
vi.mock('./ThemeStep', () => ({ ThemeStep: () => null }))

afterEach(() => {
  cleanup()
  flowState.locked = false
})

function pressEscape(): void {
  act(() => {
    fireEvent.keyDown(window, { key: 'Escape' })
  })
}

describe('onboarding Escape while work is pending', () => {
  it('does not offer to skip onboarding while the flow is locked', () => {
    flowState.locked = true
    render(<OnboardingFlow onboarding={getDefaultOnboardingState()} onOnboardingChange={vi.fn()} />)
    pressEscape()
    expect(screen.queryAllByRole('dialog', { hidden: true })).toHaveLength(1)
  })

  it('offers to skip onboarding once the flow is unlocked', () => {
    render(<OnboardingFlow onboarding={getDefaultOnboardingState()} onOnboardingChange={vi.fn()} />)
    pressEscape()
    expect(screen.queryAllByRole('dialog', { hidden: true })).toHaveLength(2)
  })
})
