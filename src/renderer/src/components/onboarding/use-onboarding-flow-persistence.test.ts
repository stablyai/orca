// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { getDefaultSettings } from '../../../../shared/constants'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { getDefaultOnboardingState } from '../../../../shared/onboarding-defaults'

const { recordFeatureInteraction } = vi.hoisted(() => ({ recordFeatureInteraction: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ recordFeatureInteraction }) } }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))

import {
  buildCompletedOnboardingNotificationSettings,
  usePersistCurrentStep
} from './use-onboarding-flow-persistence'

describe('onboarding flow persistence', () => {
  beforeEach(() => {
    window.api = {
      onboarding: { update: vi.fn().mockResolvedValue(getDefaultOnboardingState()) }
    } as unknown as typeof window.api
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
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
