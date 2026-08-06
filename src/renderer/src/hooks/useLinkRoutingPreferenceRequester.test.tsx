// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLinkRoutingPreferenceRequester } from './useLinkRoutingPreferenceRequester'

const mocks = vi.hoisted(() => ({
  settings: {
    openLinksInApp: false,
    openLinksInAppPreferencePrompted: false
  },
  updateSettings: vi.fn(),
  requestPreference: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (
    selector: (state: {
      settings: typeof mocks.settings
      updateSettings: typeof mocks.updateSettings
    }) => unknown
  ) => selector({ settings: mocks.settings, updateSettings: mocks.updateSettings })
}))

vi.mock('@/components/link-routing-preference-dialog', () => ({
  useLinkRoutingPreferenceDialog: () => mocks.requestPreference
}))

describe('useLinkRoutingPreferenceRequester', () => {
  beforeEach(() => {
    mocks.settings.openLinksInApp = false
    mocks.settings.openLinksInAppPreferencePrompted = false
    mocks.requestPreference.mockReset().mockResolvedValue(true)
    mocks.updateSettings.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
  })

  it('persists the first link-routing choice', async () => {
    const { result } = renderHook(() => useLinkRoutingPreferenceRequester())

    await act(async () => {
      await expect(result.current('https://example.com/docs')).resolves.toBe(true)
    })

    expect(mocks.requestPreference).toHaveBeenCalledWith({
      openLinksInAppDefault: false,
      url: 'https://example.com/docs'
    })
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      openLinksInApp: true,
      openLinksInAppPreferencePrompted: true
    })
  })

  it('skips the dialog after the preference is set', () => {
    mocks.settings.openLinksInAppPreferencePrompted = true
    const { result } = renderHook(() => useLinkRoutingPreferenceRequester())

    expect(result.current('https://example.com/docs')).toBeNull()
    expect(mocks.requestPreference).not.toHaveBeenCalled()
  })

  it('shares one pending choice across concurrent clicks', async () => {
    let resolvePreference: (choice: boolean) => void = () => {}
    mocks.requestPreference.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolvePreference = resolve
      })
    )
    const { result } = renderHook(() => useLinkRoutingPreferenceRequester())

    const first = result.current('https://example.com/first')
    const second = result.current('https://example.com/second')

    expect(second).toBe(first)
    expect(mocks.requestPreference).toHaveBeenCalledOnce()

    await act(async () => {
      resolvePreference(false)
      await first
    })
  })
})
