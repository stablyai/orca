// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, renderHook, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultOnboardingState, getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { OnboardingState } from '../../../../shared/onboarding-state-types'

/**
 * The wiring between the consent checkbox and the state that actually travels to main. The
 * control's own rendering is covered by AgentStatusHooksControl.test.tsx; what is covered here is
 * that OnboardingFlow hands AgentStep the props that make the box live, and that the ref closeWith
 * reads tracks the box rather than freezing at its first-render value.
 */
const { storeState, updateSettingsMock, trackMock } = vi.hoisted(() => {
  const updateSettingsMock = vi.fn(() => Promise.resolve())
  return {
    updateSettingsMock,
    trackMock: vi.fn(),
    storeState: {
      settings: null as GlobalSettings | null,
      updateSettings: updateSettingsMock,
      refreshDetectedAgents: vi.fn(() => Promise.resolve([])),
      refreshPreflightStatus: vi.fn(() => Promise.resolve()),
      recordFeatureInteraction: vi.fn(),
      openModal: vi.fn(),
      detectedAgentIds: [] as string[],
      isDetectingAgents: false,
      isRefreshingAgents: false,
      pathSource: null,
      pathFailureReason: null,
      preflightStatus: null,
      preflightStatusChecked: false,
      preflightStatusLoading: false,
      linearStatus: null,
      linearStatusChecked: false
    }
  }
})

vi.mock('@/store', () => {
  const useAppStore = (selector: (state: typeof storeState) => unknown): unknown =>
    selector(storeState)
  useAppStore.getState = (): typeof storeState => storeState
  return { useAppStore }
})

vi.mock('@/lib/telemetry', () => ({ track: trackMock }))

import OnboardingFlow from './OnboardingFlow'
import { useOnboardingFlow } from './use-onboarding-flow'

const CHECKBOX_LABEL = 'Enable agent status hooks'

function onboardingUpdateMock(): ReturnType<typeof vi.fn> {
  return (window as unknown as { api: { onboarding: { update: ReturnType<typeof vi.fn> } } }).api
    .onboarding.update
}

function freshOnboarding(): OnboardingState {
  return getDefaultOnboardingState()
}

beforeEach(() => {
  vi.clearAllMocks()
  storeState.settings = {
    ...getDefaultSettings('/tmp'),
    agentStatusHooksEnabled: true,
    disabledTuiAgents: ['cursor']
  } as GlobalSettings
  storeState.detectedAgentIds = ['claude', 'cursor']
  ;(window as unknown as { api: unknown }).api = {
    onboarding: { update: vi.fn(() => Promise.resolve(freshOnboarding())) },
    starNag: { onboardingCompleted: vi.fn(() => Promise.resolve()) },
    shell: { openUrl: vi.fn(() => Promise.resolve()) }
  }
})

afterEach(cleanup)

describe('OnboardingFlow hands the consent checkbox its state', () => {
  it('routes an uncheck through the flow into the settings write', async () => {
    render(<OnboardingFlow onboarding={freshOnboarding()} onOnboardingChange={vi.fn()} />)
    const checkbox = screen.getByRole('checkbox', { name: CHECKBOX_LABEL })
    expect(checkbox).toBeChecked()

    await userEvent.click(checkbox)

    // Without the value+handler props the box is a permanently checked decoration.
    expect(updateSettingsMock).toHaveBeenCalledWith({ agentStatusHooksEnabled: false })
    expect(screen.getByRole('checkbox', { name: CHECKBOX_LABEL })).not.toBeChecked()
  })

  it('tells the disclosure which agents the user has already turned off', async () => {
    render(<OnboardingFlow onboarding={freshOnboarding()} onOnboardingChange={vi.fn()} />)

    await userEvent.click(screen.getByText('What Orca changes, and when'))

    // Cursor is detected but disabled: listing it would promise a write Orca will not make.
    const rows = within(screen.getByRole('list')).getAllByRole('listitem')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('Claude')
  })
})

describe('the consent carried by a dismiss', () => {
  it('sends the box state at dismiss time, not the one it was first rendered with', async () => {
    const { result } = renderHook(() => useOnboardingFlow(freshOnboarding(), vi.fn()))

    act(() => result.current.setAgentStatusHooksEnabled(false))
    await act(async () => {
      await result.current.dismissOnboarding('keyboard')
    })

    const update = onboardingUpdateMock()
    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0][1]).toEqual({ agentStatusHooksEnabled: false })
  })
})
