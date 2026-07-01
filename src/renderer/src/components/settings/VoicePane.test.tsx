// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeveloperPermissionRequestResult } from '../../../../shared/developer-permissions-types'
import type { GlobalSettings } from '../../../../shared/types'
import type { SpeechModelManifest } from '../../../../shared/speech-types'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import { handleVoiceDictationToggle, VoicePane } from './VoicePane'

const { useAppStoreMock, useShortcutLabelMock } = vi.hoisted(() => ({
  useAppStoreMock: vi.fn(),
  useShortcutLabelMock: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: useAppStoreMock }))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: useShortcutLabelMock
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn(),
    success: vi.fn()
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    values ? fallback.replace('{{value0}}', values.value0) : fallback
}))

const sarvamModel: SpeechModelManifest = {
  id: 'sarvam-saaras-v3',
  label: 'Sarvam Cloud Model',
  description: 'Cloud transcription',
  provider: 'sarvam',
  language: 'multilingual',
  type: 'sarvam',
  streaming: true,
  sampleRate: 16000
}

const deniedMicrophoneResult: DeveloperPermissionRequestResult = {
  id: 'microphone',
  status: 'denied',
  openedSystemSettings: false
}

function makeSettings(voiceEnabled: boolean): GlobalSettings {
  return {
    voice: {
      ...getDefaultVoiceSettings(),
      enabled: voiceEnabled
    }
  } as GlobalSettings
}

function installWindowApi(
  requestMicrophonePermission: () => Promise<DeveloperPermissionRequestResult>
) {
  Object.assign(window, {
    api: {
      developerPermissions: {
        request: vi.fn(requestMicrophonePermission)
      },
      speech: {
        getCatalog: vi.fn(async () => []),
        getOpenAiApiKeyStatus: vi.fn(async () => ({ configured: false })),
        saveOpenAiApiKey: vi.fn(async () => ({ configured: true })),
        clearOpenAiApiKey: vi.fn(async () => ({ configured: false })),
        getSarvamApiKeyStatus: vi.fn(async () => ({ configured: false })),
        saveSarvamApiKey: vi.fn(async () => ({ configured: true })),
        clearSarvamApiKey: vi.fn(async () => ({ configured: false })),
        onDownloadProgress: vi.fn(() => () => {}),
        downloadModel: vi.fn()
      }
    }
  })
}

async function renderVoicePane(args: {
  voiceEnabled: boolean
  markFeatureTipsSeen: (ids: string[]) => void
  updateSettings: (updates: Partial<GlobalSettings>) => void
  requestMicrophonePermission?: () => Promise<DeveloperPermissionRequestResult>
  recordFeatureInteraction?: (id: string) => void
}): Promise<{ button: HTMLButtonElement; root: Root; container: HTMLDivElement }> {
  const refreshModelStates = vi.fn()
  useAppStoreMock.mockImplementation((selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      modelStates: [],
      refreshModelStates,
      markFeatureTipsSeen: args.markFeatureTipsSeen,
      recordFeatureInteraction: args.recordFeatureInteraction ?? vi.fn()
    })
  )
  useShortcutLabelMock.mockReturnValue('Ctrl+Shift+Y')
  installWindowApi(args.requestMicrophonePermission ?? vi.fn(async () => deniedMicrophoneResult))

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <VoicePane settings={makeSettings(args.voiceEnabled)} updateSettings={args.updateSettings} />
    )
  })

  const button = container.querySelector<HTMLButtonElement>('button[role="switch"]')
  if (!button) {
    throw new Error('Voice Dictation switch was not rendered')
  }

  return { button, root, container }
}

async function clickSwitch(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {
    await Promise.resolve()
  })
}

describe('VoicePane dictation switch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  beforeEach(() => {
    useAppStoreMock.mockReset()
    useShortcutLabelMock.mockReset()
  })

  it('clicking the switch marks the voice tip seen before disabling voice settings', async () => {
    const calls: string[] = []
    const requestMicrophonePermission = vi.fn()
    const updateVoiceSettings = vi.fn((updates: { enabled?: boolean }) => {
      calls.push(`settings:${String(updates.enabled)}`)
    })

    await handleVoiceDictationToggle({
      voiceEnabled: true,
      markFeatureTipsSeen: (ids) => calls.push(`seen:${ids.join(',')}`),
      updateVoiceSettings,
      requestMicrophonePermission
    })

    expect(calls).toEqual(['seen:voice-dictation', 'settings:false'])
    expect(updateVoiceSettings).toHaveBeenCalledWith({ enabled: false })
    expect(requestMicrophonePermission).not.toHaveBeenCalled()
  })

  it('clicking the switch marks the voice tip seen before the disable settings update', async () => {
    const calls: string[] = []
    const updateSettings = vi.fn((updates: Partial<GlobalSettings>) => {
      calls.push(`settings:${String(updates.voice?.enabled)}`)
    })
    const { button, root } = await renderVoicePane({
      voiceEnabled: true,
      markFeatureTipsSeen: (ids) => calls.push(`seen:${ids.join(',')}`),
      updateSettings,
      requestMicrophonePermission: vi.fn(async () => deniedMicrophoneResult)
    })

    await clickSwitch(button)
    root.unmount()

    expect(calls).toEqual(['seen:voice-dictation', 'settings:false'])
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        voice: expect.objectContaining({ enabled: false })
      })
    )
    expect(window.api.developerPermissions.request).not.toHaveBeenCalled()
  })

  it('clicking the switch marks the voice tip seen before requesting microphone permission', async () => {
    const calls: string[] = []
    const updateSettings = vi.fn((updates: Partial<GlobalSettings>) => {
      calls.push(`settings:${String(updates.voice?.enabled)}`)
    })
    const { button, root } = await renderVoicePane({
      voiceEnabled: false,
      markFeatureTipsSeen: (ids) => calls.push(`seen:${ids.join(',')}`),
      updateSettings,
      requestMicrophonePermission: async () => {
        calls.push('permission-request')
        return deniedMicrophoneResult
      }
    })

    await clickSwitch(button)
    root.unmount()

    expect(calls).toEqual(['seen:voice-dictation', 'permission-request'])
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('marks the voice tip seen before requesting microphone permission when enabling is denied', async () => {
    const calls: string[] = []
    const updateVoiceSettings = vi.fn((updates: { enabled?: boolean }) => {
      calls.push(`settings:${String(updates.enabled)}`)
    })

    await handleVoiceDictationToggle({
      voiceEnabled: false,
      markFeatureTipsSeen: (ids) => calls.push(`seen:${ids.join(',')}`),
      updateVoiceSettings,
      requestMicrophonePermission: async () => {
        calls.push('permission-request')
        return deniedMicrophoneResult
      },
      setPermissionPending: (pending) => calls.push(`pending:${String(pending)}`),
      notifyPermissionRequired: () => calls.push('permission-required')
    })

    expect(calls).toEqual([
      'seen:voice-dictation',
      'pending:true',
      'permission-request',
      'permission-required',
      'pending:false'
    ])
    expect(updateVoiceSettings).not.toHaveBeenCalled()
  })

  it('does not record voice feature interaction from the settings switch', async () => {
    const recordFeatureInteraction = vi.fn()
    const { button, root } = await renderVoicePane({
      voiceEnabled: true,
      markFeatureTipsSeen: vi.fn(),
      updateSettings: vi.fn(),
      recordFeatureInteraction
    })

    await clickSwitch(button)
    root.unmount()

    expect(recordFeatureInteraction).not.toHaveBeenCalled()
  })
})

function installSarvamWindowApi(configured: boolean): void {
  Object.assign(window, {
    api: {
      developerPermissions: { request: vi.fn() },
      speech: {
        getCatalog: vi.fn(async () => [sarvamModel]),
        getOpenAiApiKeyStatus: vi.fn(async () => ({ configured: false })),
        saveOpenAiApiKey: vi.fn(async () => ({ configured: true })),
        clearOpenAiApiKey: vi.fn(async () => ({ configured: false })),
        getSarvamApiKeyStatus: vi.fn(async () => ({ configured })),
        saveSarvamApiKey: vi.fn(async () => ({ configured: true })),
        clearSarvamApiKey: vi.fn(async () => ({ configured: false })),
        onDownloadProgress: vi.fn(() => () => {}),
        downloadModel: vi.fn()
      }
    }
  })
}

async function renderSarvamPane(args: {
  sarvamConfigured: boolean
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): Promise<{ root: Root; refreshModelStates: ReturnType<typeof vi.fn> }> {
  const refreshModelStates = vi.fn()
  useAppStoreMock.mockImplementation((selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      modelStates: [],
      refreshModelStates,
      markFeatureTipsSeen: vi.fn(),
      recordFeatureInteraction: vi.fn()
    })
  )
  useShortcutLabelMock.mockReturnValue('Ctrl+Shift+Y')
  installSarvamWindowApi(args.sarvamConfigured)

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const settings = {
    voice: {
      ...getDefaultVoiceSettings(),
      enabled: true,
      sttModel: sarvamModel.id,
      sarvamApiKeyConfigured: args.sarvamConfigured
    }
  } as GlobalSettings
  await act(async () => {
    root.render(<VoicePane settings={settings} updateSettings={args.updateSettings} />)
  })
  // Flush the async getCatalog / key-status effects so the Sarvam row renders.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

  return { root, refreshModelStates }
}

function findBodyButton(predicate: (button: HTMLButtonElement) => boolean): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll('button')).find(predicate)
  if (!button) {
    throw new Error('Button not found')
  }
  return button
}

describe('VoicePane Sarvam key flow', () => {
  beforeEach(() => {
    useAppStoreMock.mockReset()
    useShortcutLabelMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('saves a Sarvam key from the dialog and selects the pending model', async () => {
    const updateSettings = vi.fn()
    const { root, refreshModelStates } = await renderSarvamPane({
      sarvamConfigured: false,
      updateSettings
    })

    const addButton = findBodyButton((b) => b.textContent?.includes('Add API key') ?? false)
    await act(async () => {
      addButton.click()
      await Promise.resolve()
    })

    const input = document.body.querySelector<HTMLInputElement>('#sarvam-speech-api-key')
    expect(input).not.toBeNull()
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!
    await act(async () => {
      valueSetter.call(input, 'sarvam-secret')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const saveButton = findBodyButton((b) => b.textContent?.includes('Save Key') ?? false)
    await act(async () => {
      saveButton.click()
      await Promise.resolve()
    })

    expect(window.api.speech.saveSarvamApiKey).toHaveBeenCalledWith('sarvam-secret')
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        voice: expect.objectContaining({
          sarvamApiKeyConfigured: true,
          sttModel: sarvamModel.id
        })
      })
    )
    expect(refreshModelStates).toHaveBeenCalled()
    root.unmount()
  })

  it('clears the Sarvam key and deselects the active Sarvam model', async () => {
    const updateSettings = vi.fn()
    const { root, refreshModelStates } = await renderSarvamPane({
      sarvamConfigured: true,
      updateSettings
    })

    const disconnectButton = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Disconnect Sarvam API key"]'
    )
    expect(disconnectButton).not.toBeNull()
    await act(async () => {
      disconnectButton!.click()
      await Promise.resolve()
    })

    expect(window.api.speech.clearSarvamApiKey).toHaveBeenCalled()
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        voice: expect.objectContaining({
          sarvamApiKeyConfigured: false,
          sttModel: ''
        })
      })
    )
    expect(refreshModelStates).toHaveBeenCalled()
    root.unmount()
  })
})
