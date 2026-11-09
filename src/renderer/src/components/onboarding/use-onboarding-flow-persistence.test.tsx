// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { getDefaultOnboardingState } from '../../../../shared/onboarding-defaults'
import { useOnboardingFlow } from './use-onboarding-flow'

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useAppStore.setState(useAppStore.getInitialState(), true)
  vi.unstubAllGlobals()
})

describe('onboarding completion persistence', () => {
  it('keeps onboarding open when the real settings action cannot acknowledge completion', async () => {
    const saveSettings = vi.fn().mockRejectedValue(new Error('settings write failed'))
    const saveProgress = vi.fn().mockResolvedValue(getDefaultOnboardingState())
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        settings: { set: saveSettings },
        onboarding: { update: saveProgress },
        starNag: { onboardingCompleted: vi.fn() }
      }
    })
    const notify = vi.spyOn(toast, 'error').mockImplementation(() => 'notice')
    const openModal = vi.fn()
    useAppStore.setState({
      settings: { ...getDefaultSettings('/tmp'), defaultTuiAgent: 'claude' },
      refreshDetectedAgents: vi.fn().mockResolvedValue(['claude']),
      refreshNativeDetectedAgents: vi.fn().mockResolvedValue(['claude']),
      refreshPreflightStatus: vi.fn().mockResolvedValue(undefined),
      openModal
    })
    const onOnboardingChange = vi.fn()
    const { result } = renderHook(() =>
      useOnboardingFlow(
        {
          ...getDefaultOnboardingState(),
          lastCompletedStep: 4
        },
        onOnboardingChange
      )
    )
    await act(() => result.current.next())
    expect(saveSettings).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ defaultTuiAgent: 'claude' })
    )
    expect(saveProgress).not.toHaveBeenCalled()
    expect(onOnboardingChange).not.toHaveBeenCalled()
    expect(openModal).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledOnce()
  })
})
