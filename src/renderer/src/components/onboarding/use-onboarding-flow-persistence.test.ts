// @vitest-environment happy-dom

import { createElement, useEffect, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultOnboardingState } from '../../../../shared/onboarding-defaults'
import type { OnboardingState } from '../../../../shared/onboarding-state-types'

const trackMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/telemetry', () => ({
  track: trackMock
}))

import {
  buildCompletedOnboardingNotificationSettings,
  onboardingChatPermissionSetting,
  useCloseWith,
  type DismissedExtras
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

  it('preserves explicit focus notification suppression when completing onboarding', () => {
    const notifications = buildCompletedOnboardingNotificationSettings({
      enabled: false,
      agentTaskComplete: false,
      terminalBell: false,
      suppressWhenFocused: false,
      showDockBadge: false,
      customSoundId: 'two-tone',
      customSoundPath: null,
      customSoundVolume: 60,
      mutedNotificationSourceIds: [],
      notifyHiddenWorkspaces: false
    })

    expect(notifications).toEqual({
      enabled: true,
      agentTaskComplete: true,
      terminalBell: true,
      suppressWhenFocused: false,
      showDockBadge: false,
      customSoundId: 'two-tone',
      customSoundPath: null,
      customSoundVolume: 60,
      mutedNotificationSourceIds: [],
      notifyHiddenWorkspaces: false
    })
  })

  it('sets new chats from a flipped Yolo mode, keeping a custom mode and an untouched replay', () => {
    const set = (mode: string) => ({ nativeChatPermissionMode: mode })
    expect(onboardingChatPermissionSetting('full-access', false, true)).toEqual(set('ask'))
    expect(onboardingChatPermissionSetting('ask', true, true)).toEqual(set('full-access'))
    expect(onboardingChatPermissionSetting('ask', true, false)).toEqual({})
    expect(onboardingChatPermissionSetting('auto', false, true)).toEqual({})
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
