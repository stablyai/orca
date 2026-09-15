// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

const { storeState, updateSettingsMock, refreshDetectedAgentsMock, trackMock } = vi.hoisted(() => {
  const updateSettingsMock = vi.fn(() => Promise.resolve())
  const refreshDetectedAgentsMock = vi.fn(() => Promise.resolve([]))
  return {
    updateSettingsMock,
    refreshDetectedAgentsMock,
    trackMock: vi.fn(),
    storeState: {
      settings: null as GlobalSettings | null,
      updateSettings: updateSettingsMock,
      refreshDetectedAgents: refreshDetectedAgentsMock,
      detectedAgentIds: [] as string[],
      isDetectingAgents: false,
      isRefreshingAgents: false,
      pathSource: null,
      pathFailureReason: null
    }
  }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))

vi.mock('@/lib/telemetry', () => ({ track: trackMock }))

import { useOnboardingSettingsDraft } from './use-onboarding-settings-draft'

function hydrate(settings: Partial<GlobalSettings>): void {
  storeState.settings = settings as GlobalSettings
}

beforeEach(() => {
  storeState.settings = null
  updateSettingsMock.mockClear()
  refreshDetectedAgentsMock.mockClear()
  trackMock.mockClear()
})

afterEach(cleanup)

describe('useOnboardingSettingsDraft agent status hooks consent', () => {
  it('persists an uncheck immediately, without any Continue', async () => {
    // Deliberately no next()/Continue/Cmd+Enter anywhere in this test: the write must not depend
    // on the commit path, because dismiss and skip persist nothing.
    hydrate({ agentStatusHooksEnabled: true })
    const { result } = renderHook(() => useOnboardingSettingsDraft())

    act(() => result.current.setAgentStatusHooksEnabled(false))

    expect(updateSettingsMock).toHaveBeenCalledTimes(1)
    expect(updateSettingsMock).toHaveBeenCalledWith({ agentStatusHooksEnabled: false })
    await waitFor(() => expect(result.current.agentStatusHooksEnabled).toBe(false))
  })

  it('keeps the recorded write when the wizard unmounts without committing', () => {
    hydrate({ agentStatusHooksEnabled: true })
    const { result, unmount } = renderHook(() => useOnboardingSettingsDraft())

    act(() => result.current.setAgentStatusHooksEnabled(false))
    unmount()

    expect(updateSettingsMock.mock.calls).toEqual([[{ agentStatusHooksEnabled: false }]])
  })

  it('does not re-check a cleared box when settings hydrate late', async () => {
    const { result, rerender } = renderHook(() => useOnboardingSettingsDraft())
    act(() => result.current.setAgentStatusHooksEnabled(false))

    hydrate({ agentStatusHooksEnabled: true })
    rerender()

    await waitFor(() => expect(result.current.agentStatusHooksEnabled).toBe(false))
  })

  it('still adopts a persisted off value when the user has not touched the box', async () => {
    const { result, rerender } = renderHook(() => useOnboardingSettingsDraft())
    expect(result.current.agentStatusHooksEnabled).toBe(true)

    hydrate({ agentStatusHooksEnabled: false })
    rerender()

    await waitFor(() => expect(result.current.agentStatusHooksEnabled).toBe(false))
  })
})

describe('useOnboardingSettingsDraft theme setters', () => {
  it('exports setTheme as the interaction-tracking setter', async () => {
    const { result, rerender } = renderHook(() => useOnboardingSettingsDraft())
    act(() => result.current.setTheme('light'))

    hydrate({ theme: 'dark' })
    rerender()

    await waitFor(() => expect(result.current.theme).toBe('light'))
  })

  it('names the hydration-clobbering setter so misuse is obvious', async () => {
    const { result, rerender } = renderHook(() => useOnboardingSettingsDraft())
    act(() => result.current.setThemeFromPersistedSettings('light'))

    hydrate({ theme: 'dark' })
    rerender()

    await waitFor(() => expect(result.current.theme).toBe('dark'))
  })
})
