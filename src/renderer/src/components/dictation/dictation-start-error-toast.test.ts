import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_SPEECH_UNAVAILABLE_ERROR_CODE } from '../../../../shared/speech-types'

const { openSettingsPageMock, openSettingsTargetMock, toastErrorMock } = vi.hoisted(() => ({
  openSettingsPageMock: vi.fn(),
  openSettingsTargetMock: vi.fn(),
  toastErrorMock: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: toastErrorMock })
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      openSettingsPage: openSettingsPageMock,
      openSettingsTarget: openSettingsTargetMock
    })
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { showDictationStartErrorToast } from './dictation-start-error-toast'

describe('showDictationStartErrorToast', () => {
  beforeEach(() => {
    openSettingsPageMock.mockReset()
    openSettingsTargetMock.mockReset()
    toastErrorMock.mockReset()
  })

  it('maps unavailable local speech to a localized remediation toast', () => {
    showDictationStartErrorToast(LOCAL_SPEECH_UNAVAILABLE_ERROR_CODE)

    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining('Windows ARM64'),
      expect.objectContaining({
        action: expect.objectContaining({ label: 'Open Settings' })
      })
    )
    const options = toastErrorMock.mock.calls[0]?.[1]
    options.action.onClick()
    expect(openSettingsTargetMock).toHaveBeenCalledWith({ pane: 'voice', repoId: null })
    expect(openSettingsPageMock).toHaveBeenCalledTimes(1)
  })
})
