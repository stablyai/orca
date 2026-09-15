// @vitest-environment happy-dom

import { createElement, useEffect, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultOnboardingState } from '../../../../shared/constants'
import type { OnboardingConsent, OnboardingState } from '../../../../shared/onboarding-state-types'

const trackMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/telemetry', () => ({
  track: trackMock
}))

import {
  buildCompletedOnboardingNotificationSettings,
  buildOnboardingDismissedPayload,
  persistStep,
  useCloseWith,
  usePersistCurrentStep,
  type DismissedExtras,
  trackOnboardingDismissed
} from './use-onboarding-flow-persistence'
import type { StepNumber } from './use-onboarding-flow-types'

type CloseWithCallback = (
  outcome: 'completed' | 'dismissed',
  lastStepReached: StepNumber,
  completedPath?: 'add_project_modal',
  dismissedExtras?: DismissedExtras
) => Promise<boolean>

const probeStartTime = Date.now()

function makeOnboardingState(): OnboardingState {
  return {
    ...getDefaultOnboardingState(),
    closedAt: Date.now(),
    outcome: 'completed',
    lastCompletedStep: 5
  }
}

function setApi(api: {
  onboarding: { update: ReturnType<typeof vi.fn> }
  starNag: { onboardingCompleted: ReturnType<typeof vi.fn> }
}): void {
  ;(window as unknown as { api: typeof api }).api = api
}

function CloseWithProbe(props: {
  onReady: (closeWith: CloseWithCallback) => void
  consent?: OnboardingConsent
}): null {
  const closeWith = useCloseWith({
    onOnboardingChange: vi.fn(),
    startTimeRef: { current: probeStartTime },
    setError: vi.fn(),
    consent: props.consent ?? {}
  })
  useEffect(() => props.onReady(closeWith), [closeWith, props])
  return null
}

function renderCloseWithProbe(
  onReady: (closeWith: CloseWithCallback) => void,
  consent?: OnboardingConsent
): {
  root: Root
  container: HTMLDivElement
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(createElement(CloseWithProbe, { onReady, consent })))
  return { root, container }
}

describe('onboarding flow persistence', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    trackMock.mockClear()
    setApi({
      onboarding: { update: vi.fn().mockResolvedValue(makeOnboardingState()) },
      starNag: { onboardingCompleted: vi.fn().mockResolvedValue(undefined) }
    })
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
    vi.useRealTimers()
  })

  it('builds dismissed telemetry with the triggering advance path', () => {
    expect(
      buildOnboardingDismissedPayload(3, {
        durationMs: 250,
        advancedVia: 'keyboard'
      })
    ).toEqual({
      last_step: 3,
      duration_ms: 250,
      advanced_via: 'keyboard'
    })
  })

  it('tracks dismissed onboarding telemetry with the triggering advance path', () => {
    trackOnboardingDismissed(3, {
      durationMs: 250,
      advancedVia: 'keyboard'
    })

    expect(trackMock).toHaveBeenCalledWith('onboarding_dismissed', {
      last_step: 3,
      duration_ms: 250,
      advanced_via: 'keyboard'
    })
  })

  it('preserves explicit focus notification suppression when completing onboarding', () => {
    const notifications = buildCompletedOnboardingNotificationSettings({
      enabled: false,
      agentTaskComplete: false,
      terminalBell: false,
      suppressWhenFocused: false,
      customSoundId: 'two-tone',
      customSoundPath: null,
      customSoundVolume: 60
    })

    expect(notifications).toEqual({
      enabled: true,
      agentTaskComplete: true,
      terminalBell: true,
      suppressWhenFocused: false,
      customSoundId: 'two-tone',
      customSoundPath: null,
      customSoundVolume: 60
    })
  })

  it('schedules the star toast after every completed close path', async () => {
    let closeWith: CloseWithCallback | null = null
    ;({ root, container } = renderCloseWithProbe((callback) => {
      closeWith = callback
    }))

    await act(async () => {
      await closeWith?.('completed', 5)
    })

    const api = (
      window as unknown as {
        api: {
          starNag: { onboardingCompleted: ReturnType<typeof vi.fn> }
        }
      }
    ).api
    expect(api.starNag.onboardingCompleted).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(0)
    })

    expect(api.starNag.onboardingCompleted).toHaveBeenCalledTimes(1)
  })

  it('carries the hook consent on the close that lifts the first-run deferral', async () => {
    // Closing the wizard also ends the deferral, so main must authorize from the same value the
    // checkbox holds — not from whatever the fire-and-forget on-change write left behind.
    let closeWith: CloseWithCallback | null = null
    ;({ root, container } = renderCloseWithProbe(
      (callback) => {
        closeWith = callback
      },
      { agentStatusHooksEnabled: false }
    ))

    await act(async () => {
      await closeWith?.('dismissed', 1)
    })

    const update = (
      window as unknown as { api: { onboarding: { update: ReturnType<typeof vi.fn> } } }
    ).api.onboarding.update
    expect(update.mock.calls[0][1]).toEqual({ agentStatusHooksEnabled: false })
  })

  it('carries the hook consent alongside the step 1 advance', async () => {
    await persistStep(1, { checklist: undefined }, { agentStatusHooksEnabled: false })

    const update = (
      window as unknown as { api: { onboarding: { update: ReturnType<typeof vi.fn> } } }
    ).api.onboarding.update
    expect(update.mock.calls[0][0]).toMatchObject({ lastCompletedStep: 1 })
    expect(update.mock.calls[0][1]).toEqual({ agentStatusHooksEnabled: false })
  })

  it('sends the unchecked box with the agent step commit', async () => {
    let commit: (() => Promise<unknown>) | null = null
    function PersistProbe(): null {
      const persistCurrentStep = usePersistCurrentStep({
        currentStepId: 'agent',
        selectedAgent: 'claude',
        yoloPermissions: false,
        agentStatusHooksEnabled: false,
        theme: 'dark',
        settings: { agentDefaultArgs: {}, agentDefaultEnv: {} } as never,
        updateSettings: vi.fn(),
        onboardingChecklist: getDefaultOnboardingState().checklist,
        onOnboardingChange: vi.fn(),
        setError: vi.fn()
      })
      useEffect(() => {
        commit = persistCurrentStep
      }, [persistCurrentStep])
      return null
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root?.render(createElement(PersistProbe)))

    await act(async () => {
      await commit?.()
    })

    const update = (
      window as unknown as { api: { onboarding: { update: ReturnType<typeof vi.fn> } } }
    ).api.onboarding.update
    expect(update.mock.calls[0][1]).toEqual({ agentStatusHooksEnabled: false })
  })
})
