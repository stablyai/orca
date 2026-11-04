// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { getDefaultSettings } from '../../../../shared/constants'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { toast } from 'sonner'
import { createElement, useEffect, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultOnboardingState } from '../../../../shared/onboarding-defaults'
import type { OnboardingState } from '../../../../shared/onboarding-state-types'

const { trackMock, recordFeatureInteraction } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  recordFeatureInteraction: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ recordFeatureInteraction }) } }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

vi.mock('@/lib/telemetry', () => ({
  track: trackMock
}))

import {
  buildCompletedOnboardingNotificationSettings,
  onboardingChatPermissionSetting,
  useCloseWith,
  usePersistCurrentStep,
  type DismissedExtras
} from './use-onboarding-flow-persistence'
import type { StepNumber } from './use-onboarding-flow-types'

type CloseWithCallback = (
  outcome: 'completed' | 'dismissed',
  lastStepReached: StepNumber,
  completedPath?: 'add_project_modal' | 'workspace',
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
    cleanup()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('preserves explicit focus notification suppression when completing onboarding', () => {
    const notifications = buildCompletedOnboardingNotificationSettings({
      enabled: false,
      agentTaskComplete: false,
      agentNeedsInput: false,
      terminalBell: false,
      suppressWhenFocused: false,
      customSoundId: 'two-tone',
      customSoundPath: null,
      customSoundVolume: 60,
      mutedNotificationSourceIds: [],
      notifyHiddenWorkspaces: false
    })

    expect(notifications).toEqual({
      enabled: true,
      agentTaskComplete: true,
      agentNeedsInput: true,
      terminalBell: true,
      suppressWhenFocused: false,
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
  it.each(['claude', null] as const)(
    'saves the visible %s pick on final completion even when the agent step was bypassed',
    async (selectedAgent: TuiAgent | null) => {
      const settings = { ...getDefaultSettings('/tmp'), defaultTuiAgent: 'codex' as const }
      const updateSettings = vi.fn().mockResolvedValue(undefined)
      const onOnboardingChange = vi.fn()
      const { result } = renderHook(() =>
        usePersistCurrentStep({
          currentStepId: 'notifications',
          selectedAgent,
          yoloPermissions: true,
          yoloPermissionsChosen: { current: false },
          theme: 'dark',
          settings,
          updateSettings,
          onboardingChecklist: getDefaultOnboardingState().checklist,
          onOnboardingChange,
          setError: vi.fn()
        })
      )
      await act(async () => {
        expect(await result.current()).toEqual({ ok: true })
      })
      expect(updateSettings).toHaveBeenCalledExactlyOnceWith({
        defaultTuiAgent: selectedAgent ?? 'blank',
        notifications: buildCompletedOnboardingNotificationSettings(settings.notifications)
      })
      expect(window.api.onboarding.update).toHaveBeenCalledWith(
        expect.objectContaining({
          lastCompletedStep: 5,
          checklist: expect.objectContaining({ choseAgent: selectedAgent !== null })
        })
      )
      expect(recordFeatureInteraction).toHaveBeenCalledExactlyOnceWith('notifications')
    }
  )

  it('uses the same explicit permission payload on the agent and completion steps', async () => {
    const settings = getDefaultSettings('/tmp')
    const writes: Partial<typeof settings>[] = []
    for (const currentStepId of ['agent', 'notifications'] as const) {
      const { result, unmount } = renderHook(() =>
        usePersistCurrentStep({
          currentStepId,
          selectedAgent: 'claude',
          yoloPermissions: true,
          yoloPermissionsChosen: { current: true },
          theme: 'dark',
          settings,
          updateSettings: (update) => {
            writes.push(update)
          },
          onboardingChecklist: getDefaultOnboardingState().checklist,
          onOnboardingChange: vi.fn(),
          setError: vi.fn()
        })
      )
      await act(async () => {
        await result.current()
      })
      unmount()
    }
    expect(writes[0]).toMatchObject({
      defaultTuiAgent: 'claude',
      nativeChatPermissionMode: 'full-access'
    })
    expect(writes[1]).toEqual({
      ...writes[0],
      notifications: buildCompletedOnboardingNotificationSettings(settings.notifications)
    })
  })

  it('keeps progress open when settings persistence rejects', async () => {
    const { result } = renderHook(() =>
      usePersistCurrentStep({
        currentStepId: 'notifications',
        selectedAgent: 'claude',
        yoloPermissions: false,
        yoloPermissionsChosen: { current: false },
        theme: 'dark',
        settings: getDefaultSettings('/tmp'),
        updateSettings: vi.fn().mockRejectedValue(new Error('write failed')),
        onboardingChecklist: getDefaultOnboardingState().checklist,
        onOnboardingChange: vi.fn(),
        setError: vi.fn()
      })
    )
    await act(async () => {
      expect(await result.current()).toEqual({ ok: false })
    })
    expect(window.api.onboarding.update).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Could not save progress')
  })
})
