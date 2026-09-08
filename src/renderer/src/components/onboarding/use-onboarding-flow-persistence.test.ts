// @vitest-environment happy-dom

import { createElement, useEffect, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultOnboardingState, getDefaultSettings } from '../../../../shared/constants'
import type { OnboardingState } from '../../../../shared/onboarding-state-types'

const trackMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/telemetry', () => ({
  track: trackMock
}))

import {
  buildCompletedOnboardingNotificationSettings,
  buildOnboardingDismissedPayload,
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

function CloseWithProbe(props: { onReady: (closeWith: CloseWithCallback) => void }): null {
  const closeWith = useCloseWith({
    onOnboardingChange: vi.fn(),
    startTimeRef: { current: probeStartTime },
    setError: vi.fn()
  })
  useEffect(() => props.onReady(closeWith), [closeWith, props])
  return null
}

function renderCloseWithProbe(onReady: (closeWith: CloseWithCallback) => void): {
  root: Root
  container: HTMLDivElement
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(createElement(CloseWithProbe, { onReady })))
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

  it.each([null, 'auto'] as const)(
    'preserves permissions unless a preset is explicitly selected (%s)',
    async (selection) => {
      const settings = getDefaultSettings('/tmp')
      settings.agentDefaultArgs = {
        ...settings.agentDefaultArgs,
        claude: '',
        codex: '--model custom'
      }
      const updateSettings = vi.fn()
      let persist: (() => Promise<{ ok: boolean }>) | undefined
      function Probe(): null {
        persist = usePersistCurrentStep({
          currentStepId: 'agent',
          selectedAgent: 'claude',
          permissionModeSelection: selection,
          theme: settings.theme,
          settings,
          updateSettings,
          onboardingChecklist: getDefaultOnboardingState().checklist,
          onOnboardingChange: vi.fn(),
          setError: vi.fn()
        })
        return null
      }
      container = document.createElement('div')
      root = createRoot(container)
      act(() => root?.render(createElement(Probe)))
      await act(async () => {
        await persist?.()
      })
      const update = updateSettings.mock.calls[0][0]
      if (selection === null) {
        expect(update).toEqual({ defaultTuiAgent: 'claude' })
      } else {
        expect(update.agentDefaultArgs.claude).toBe('--permission-mode auto')
        expect(update.agentDefaultArgs.codex).toBe('--model custom')
        expect(update.agentDefaultArgs.aider).toBe('')
      }
    }
  )

  it('does not advance onboarding when saving Auto fails and permits a retry', async () => {
    const updateSettings = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValue(undefined)
    const onOnboardingChange = vi.fn()
    const setError = vi.fn()
    let persist: (() => Promise<{ ok: boolean }>) | undefined
    function Probe() {
      persist = usePersistCurrentStep({
        currentStepId: 'agent',
        selectedAgent: 'claude',
        permissionModeSelection: 'auto',
        theme: 'dark',
        settings: getDefaultSettings('test-home'),
        updateSettings,
        onboardingChecklist: getDefaultOnboardingState().checklist,
        onOnboardingChange,
        setError
      })
      return null
    }
    container = document.createElement('div')
    root = createRoot(container)
    act(() => root?.render(createElement(Probe)))
    await act(async () => {
      expect(await persist?.()).toEqual({ ok: false })
    })
    expect(window.api.onboarding.update).not.toHaveBeenCalled()
    expect(onOnboardingChange).not.toHaveBeenCalled()
    expect(setError).toHaveBeenCalledWith('connection lost')
    await act(async () => {
      expect(await persist?.()).toEqual({ ok: true })
    })
    expect(window.api.onboarding.update).toHaveBeenCalledTimes(1)
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
})
