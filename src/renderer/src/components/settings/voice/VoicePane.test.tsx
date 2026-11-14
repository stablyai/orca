// @vitest-environment happy-dom

// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeveloperPermissionRequestResult } from '../../../../../shared/developer-permissions-types'
import type { SpeechModelManifest } from '../../../../../shared/speech-types'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { getDefaultVoiceSettings } from '../../../../../shared/constants'

import { VoicePane } from './VoicePane'

const { useAppStoreMock, useShortcutLabelMock } = vi.hoisted(() => ({
  useAppStoreMock: vi.fn(),
  useShortcutLabelMock: vi.fn()
}))

vi.mock('@/store/index', () => ({ useAppStore: useAppStoreMock }))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: useShortcutLabelMock,
  useShortcutKeyDetails: () => ({ keys: [], doubleTap: false })
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn(),
    success: vi.fn()
  }
}))

const deniedMicrophoneResult: DeveloperPermissionRequestResult = {
  id: 'microphone',
  status: 'denied',
  openedSystemSettings: false
}
const EMPTY_SPEECH_CATALOG: SpeechModelManifest[] = []

function installWindowApi(
  requestMicrophonePermission: () => Promise<DeveloperPermissionRequestResult>
) {
  Object.assign(window, {
    api: {
      developerPermissions: {
        request: vi.fn(requestMicrophonePermission)
      },
      speech: {
        getCatalog: vi.fn(async () => EMPTY_SPEECH_CATALOG),
        getOpenAiApiKeyStatus: vi.fn(async () => ({ configured: false })),
        saveOpenAiApiKey: vi.fn(async () => ({ configured: true })),
        clearOpenAiApiKey: vi.fn(async () => ({ configured: false })),
        onDownloadProgress: vi.fn(() => () => {}),
        downloadModel: vi.fn()
      }
    }
  })
}

describe('VoicePane', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  beforeEach(() => {
    useAppStoreMock.mockReset()
    useShortcutLabelMock.mockReset()
  })

  it('merges an in-flight voice write onto the newest settings, not the render-time snapshot', async () => {
    const updateSettings = vi.fn()
    let resolveClear: () => void = () => {}
    const clearing = new Promise<{ configured: boolean }>((resolve) => {
      resolveClear = () => resolve({ configured: false })
    })
    useAppStoreMock.mockImplementation((selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        modelStates: [],
        refreshModelStates: vi.fn(),
        markFeatureTipsSeen: vi.fn(),
        recordFeatureInteraction: vi.fn()
      })
    )
    useShortcutLabelMock.mockReturnValue('Ctrl+Shift+Y')
    installWindowApi(vi.fn(async () => deniedMicrophoneResult))
    window.api.speech.getOpenAiApiKeyStatus = vi.fn(async () => ({
      configured: true,
      protection: 'sealed' as const
    }))
    window.api.speech.clearOpenAiApiKey = vi.fn(() => clearing)

    const settingsWithKey = (enabled: boolean): GlobalSettings =>
      ({
        voice: {
          ...getDefaultVoiceSettings(),
          enabled,
          openAiApiKeyConfigured: true,
          microphoneDeviceId: 'usb-mic',
          microphoneDeviceLabel: 'USB Microphone'
        }
      }) as GlobalSettings

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <VoicePane
          settings={settingsWithKey(true)}
          updateSettings={updateSettings}
          writeSourceControlAiSettings={async () => {}}
        />
      )
    })

    const cloudTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    ).find((button) => button.textContent === 'Cloud')
    await act(async () => {
      cloudTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const disconnect = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Disconnect OpenAI API key"]'
    )
    if (!disconnect) {
      throw new Error('Disconnect OpenAI API key button was not rendered')
    }
    await act(async () => {
      disconnect.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await act(async () => {
      root.render(
        <VoicePane
          settings={settingsWithKey(false)}
          updateSettings={updateSettings}
          writeSourceControlAiSettings={async () => {}}
        />
      )
    })

    await act(async () => {
      resolveClear()
      await clearing
    })
    root.unmount()

    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updateSettings).toHaveBeenCalledWith({
      voice: {
        ...getDefaultVoiceSettings(),
        enabled: false,
        openAiApiKeyConfigured: false,
        microphoneDeviceId: 'usb-mic',
        microphoneDeviceLabel: 'USB Microphone'
      }
    })
  })
})
