// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { AppState } from '@/store/types'
import { showMobileEmulatorHiddenToast } from './mobile-emulator-hidden-toast'

vi.mock('sonner', () => ({
  toast: {
    dismiss: vi.fn(),
    info: vi.fn()
  }
}))

afterEach(() => {
  vi.clearAllMocks()
})

describe('showMobileEmulatorHiddenToast', () => {
  it('auto-dismisses after 30s while staying dismissible', () => {
    showMobileEmulatorHiddenToast({
      openSettingsPage: vi.fn() as unknown as AppState['openSettingsPage'],
      openSettingsTarget: vi.fn() as unknown as AppState['openSettingsTarget']
    })

    const infoMock = vi.mocked(toast.info)
    expect(infoMock).toHaveBeenCalledTimes(1)
    const options = infoMock.mock.calls[0]?.[1]
    // Why: a finite duration is the fix for the toast lingering forever; assert
    // the exact value so a regression to Infinity is caught.
    expect(options).toMatchObject({
      id: 'mobile-emulator-hidden',
      duration: 30_000,
      dismissible: true
    })
  })
})
