// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeveloperPermissionRequestResult } from '../../../../shared/developer-permissions-types'
import type { SpeechModelManifest } from '../../../../shared/speech-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import type { CloudSpeechKeyStatus } from '../../../../shared/cloud-speech-providers'
import { TooltipProvider } from '../ui/tooltip'
import { handleVoiceDictationToggle, VoicePane } from './VoicePane'

const { useAppStoreMock, useShortcutLabelMock } = vi.hoisted(() => ({
  useAppStoreMock: vi.fn(),
  useShortcutLabelMock: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: useAppStoreMock }))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: useShortcutLabelMock
}))

const { toastSuccessMock } = vi.hoisted(() => ({ toastSuccessMock: vi.fn() }))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn(),
    success: toastSuccessMock
  }
}))

const deniedMicrophoneResult: DeveloperPermissionRequestResult = {
  id: 'microphone',
  status: 'denied',
  openedSystemSettings: false
}
const EMPTY_SPEECH_CATALOG: SpeechModelManifest[] = []

function keyStatus(
  providerId: CloudSpeechKeyStatus['providerId'],
  configured: boolean
): CloudSpeechKeyStatus {
  return {
    providerId,
    configured,
    hint: configured ? '…a1b2' : null,
    protection: configured ? 'sealed' : null
  }
}

function makeSettings(voiceEnabled?: boolean): GlobalSettings {
  if (voiceEnabled === undefined) {
    return {} as GlobalSettings
  }
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
      shell: {
        openUrl: vi.fn()
      },
      speech: {
        getCatalog: vi.fn(async () => EMPTY_SPEECH_CATALOG),
        getCloudKeyStatuses: vi.fn(async (): Promise<CloudSpeechKeyStatus[]> => []),
        saveCloudKey: vi.fn(async (providerId: CloudSpeechKeyStatus['providerId']) =>
          keyStatus(providerId, true)
        ),
        clearCloudKey: vi.fn(async (providerId: CloudSpeechKeyStatus['providerId']) =>
          keyStatus(providerId, false)
        ),
        testCloudKey: vi.fn(async () => ({ ok: true, message: null })),
        onDownloadProgress: vi.fn(() => () => {}),
        downloadModel: vi.fn()
      }
    }
  })
}

async function renderVoicePane(args: {
  voiceEnabled?: boolean
  markFeatureTipsSeen: (ids: string[]) => void
  updateSettings: (updates: Partial<GlobalSettings>) => void
  requestMicrophonePermission?: () => Promise<DeveloperPermissionRequestResult>
  recordFeatureInteraction?: (id: string) => void
}): Promise<{
  button: HTMLButtonElement
  root: Root
  container: HTMLDivElement
  refreshModelStates: ReturnType<typeof vi.fn>
}> {
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
      <TooltipProvider>
        <VoicePane
          settings={makeSettings(args.voiceEnabled)}
          updateSettings={args.updateSettings}
        />
      </TooltipProvider>
    )
  })

  const button = container.querySelector<HTMLButtonElement>('button[role="switch"]')
  if (!button) {
    throw new Error('Voice Dictation switch was not rendered')
  }

  return { button, root, container, refreshModelStates }
}

async function clickSwitch(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {
    await Promise.resolve()
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

  it('fetches speech data once across re-renders when voice settings are absent', async () => {
    const updateSettings = vi.fn()
    const { root, refreshModelStates } = await renderVoicePane({
      markFeatureTipsSeen: vi.fn(),
      updateSettings
    })

    for (let i = 0; i < 4; i++) {
      await act(async () => {
        root.render(
          <TooltipProvider>
            <VoicePane settings={makeSettings()} updateSettings={updateSettings} />
          </TooltipProvider>
        )
      })
    }
    act(() => root.unmount())

    expect(window.api.speech.getCatalog).toHaveBeenCalledTimes(1)
    expect(window.api.speech.getCloudKeyStatuses).toHaveBeenCalledTimes(1)
    expect(refreshModelStates).toHaveBeenCalledTimes(1)
  })

  it('re-reads key and model state when main re-publishes voice settings', async () => {
    const updateSettings = vi.fn()
    const { root, refreshModelStates } = await renderVoicePane({
      voiceEnabled: true,
      markFeatureTipsSeen: vi.fn(),
      updateSettings
    })
    const rerender = async (settings: GlobalSettings): Promise<void> => {
      await act(async () => {
        root.render(
          <TooltipProvider>
            <VoicePane settings={settings} updateSettings={updateSettings} />
          </TooltipProvider>
        )
      })
    }
    const published = makeSettings(true)
    // A phone saving a key arrives as a new `voice` object from main.
    await rerender(published)
    await rerender(published)
    act(() => root.unmount())

    expect(window.api.speech.getCloudKeyStatuses).toHaveBeenCalledTimes(2)
    expect(refreshModelStates).toHaveBeenCalledTimes(2)
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

  it('merges an in-flight voice write onto the newest settings, not the render-time snapshot', async () => {
    const updateSettings = vi.fn()
    let resolveClear: () => void = () => {}
    const clearing = new Promise<CloudSpeechKeyStatus>((resolve) => {
      resolveClear = () => resolve(keyStatus('openai', false))
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
    window.api.speech.getCloudKeyStatuses = vi.fn(async () => [keyStatus('openai', true)])
    window.api.speech.clearCloudKey = vi.fn(() => clearing)

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
        <TooltipProvider>
          <VoicePane settings={settingsWithKey(true)} updateSettings={updateSettings} />
        </TooltipProvider>
      )
    })

    const disconnect = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove OpenAI API key"]'
    )
    if (!disconnect) {
      throw new Error('Remove OpenAI API key button was not rendered')
    }
    await act(async () => {
      disconnect.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // The user turns dictation off while the clear-key IPC is still in flight.
    await act(async () => {
      root.render(
        <TooltipProvider>
          <VoicePane settings={settingsWithKey(false)} updateSettings={updateSettings} />
        </TooltipProvider>
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

  it('verifies a new provider key before saving and offers an unverified save on rejection', async () => {
    const updateSettings = vi.fn()
    const { root } = await renderVoicePane({
      voiceEnabled: true,
      markFeatureTipsSeen: vi.fn(),
      updateSettings
    })
    window.api.speech.saveCloudKey = vi.fn(async (providerId, _apiKey, verify) => {
      if (verify) {
        throw new Error(
          "Error invoking remote method 'speech:saveCloudKey': Error: Soniox rejected this API key (401)."
        )
      }
      return keyStatus(providerId, true)
    })

    await clickButton(findButton(document.body, 'Add API key'))
    const input = document.querySelector<HTMLInputElement>('#cloud-speech-api-key')
    if (!input) {
      throw new Error('API key input was not rendered')
    }
    await typeInto(input, '  soniox-test-key  ')
    await clickButton(findButton(document.body, 'Check and save'))

    expect(window.api.speech.saveCloudKey).toHaveBeenCalledWith('soniox', 'soniox-test-key', true)
    expect(document.body.textContent).toContain('Soniox rejected this API key (401).')
    expect(document.querySelector('#cloud-speech-api-key')).not.toBeNull()

    await clickButton(findButton(document.body, 'Save without checking'))

    expect(window.api.speech.saveCloudKey).toHaveBeenLastCalledWith(
      'soniox',
      'soniox-test-key',
      false
    )
    expect(document.querySelector('#cloud-speech-api-key')).toBeNull()
    expect(toastSuccessMock).toHaveBeenCalledWith('Soniox API key saved')
    expect(document.body.textContent).toContain('…a1b2')
    root.unmount()
  })

  it('does not let a save from a closed dialog close a newer provider dialog', async () => {
    const { root } = await renderVoicePane({
      voiceEnabled: true,
      markFeatureTipsSeen: vi.fn(),
      updateSettings: vi.fn()
    })
    let resolveSave: () => void = () => {}
    window.api.speech.saveCloudKey = vi.fn(
      (providerId: CloudSpeechKeyStatus['providerId']) =>
        new Promise<CloudSpeechKeyStatus>((resolve) => {
          resolveSave = () => resolve(keyStatus(providerId, true))
        })
    )

    await clickButton(findButton(document.body, 'Add API key'))
    const input = document.querySelector<HTMLInputElement>('#cloud-speech-api-key')
    if (!input) {
      throw new Error('API key input was not rendered')
    }
    await typeInto(input, 'soniox-test-key')
    await clickButton(findButton(document.body, 'Check and save'))
    await clickButton(findButton(document.body, 'Close'))
    // Soniox is still saving, so its row button is disabled; open the next free provider.
    const nextAddButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Add API key' && !candidate.disabled
    )
    if (!nextAddButton) {
      throw new Error('No enabled "Add API key" button was rendered')
    }
    await clickButton(nextAddButton)
    const newerTitle = document.querySelector('[data-slot="dialog-title"]')?.textContent

    await act(async () => {
      resolveSave()
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(newerTitle).not.toContain('Soniox')
    expect(document.querySelector('#cloud-speech-api-key')).not.toBeNull()
    expect(document.querySelector('[data-slot="dialog-title"]')?.textContent).toBe(newerTitle)
    root.unmount()
  })

  it('deselects a removed provider model even when the catalog had not loaded at click time', async () => {
    const updateSettings = vi.fn()
    const groqModel: SpeechModelManifest = {
      id: 'groq-whisper-large-v3',
      label: 'Whisper Large v3',
      description: 'Groq',
      provider: 'groq',
      language: 'multi',
      type: 'cloud',
      sampleRate: 16000,
      streaming: false
    }
    const storeState = {
      modelStates: [],
      refreshModelStates: vi.fn(),
      markFeatureTipsSeen: vi.fn()
    }
    useAppStoreMock.mockImplementation((selector: (state: Record<string, unknown>) => unknown) =>
      selector(storeState)
    )
    useShortcutLabelMock.mockReturnValue('Ctrl+Shift+Y')
    installWindowApi(vi.fn(async () => deniedMicrophoneResult))
    window.api.speech.getCloudKeyStatuses = vi.fn(async () => [keyStatus('groq', true)])
    // The first fetch races the click and returns nothing; the clear must re-read the catalog.
    window.api.speech.getCatalog = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([groqModel])
    const settings: GlobalSettings = {
      ...makeSettings(),
      voice: { ...getDefaultVoiceSettings(), enabled: true, sttModel: groqModel.id }
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <TooltipProvider>
          <VoicePane settings={settings} updateSettings={updateSettings} />
        </TooltipProvider>
      )
    })

    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove Groq API key"]'
    )
    if (!remove) {
      throw new Error('Remove Groq API key button was not rendered')
    }
    await clickButton(remove)
    await act(async () => {
      await Promise.resolve()
    })
    root.unmount()

    expect(window.api.speech.getCatalog).toHaveBeenCalledTimes(2)
    expect(updateSettings).toHaveBeenCalledWith({
      voice: expect.objectContaining({ sttModel: '' })
    })
  })

  it('reports a removed key as removed when the follow-up model refresh fails', async () => {
    const { toast } = await import('sonner')
    vi.mocked(toast.error).mockClear()
    toastSuccessMock.mockClear()
    useAppStoreMock.mockImplementation((selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        modelStates: [],
        refreshModelStates: vi.fn(() => Promise.reject(new Error('refresh failed'))),
        markFeatureTipsSeen: vi.fn()
      })
    )
    useShortcutLabelMock.mockReturnValue('Ctrl+Shift+Y')
    installWindowApi(vi.fn(async () => deniedMicrophoneResult))
    window.api.speech.getCloudKeyStatuses = vi.fn(async () => [keyStatus('groq', true)])
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <TooltipProvider>
          <VoicePane settings={makeSettings(true)} updateSettings={vi.fn()} />
        </TooltipProvider>
      )
    })

    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove Groq API key"]'
    )
    if (!remove) {
      throw new Error('Remove Groq API key button was not rendered')
    }
    await clickButton(remove)
    await act(async () => {
      await Promise.resolve()
    })
    root.unmount()

    expect(window.api.speech.clearCloudKey).toHaveBeenCalledWith('groq')
    expect(toastSuccessMock).toHaveBeenCalledWith('Groq API key removed')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('shows the provider verdict after testing a saved key', async () => {
    useAppStoreMock.mockImplementation((selector: (state: Record<string, unknown>) => unknown) =>
      selector({ modelStates: [], refreshModelStates: vi.fn(), markFeatureTipsSeen: vi.fn() })
    )
    useShortcutLabelMock.mockReturnValue('Ctrl+Shift+Y')
    installWindowApi(vi.fn(async () => deniedMicrophoneResult))
    window.api.speech.getCloudKeyStatuses = vi.fn(async () => [keyStatus('groq', true)])
    window.api.speech.testCloudKey = vi.fn(async () => ({
      ok: false,
      message: 'Groq rejected this API key (401).'
    }))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <TooltipProvider>
          <VoicePane settings={makeSettings(true)} updateSettings={vi.fn()} />
        </TooltipProvider>
      )
    })

    await clickButton(findButton(container, 'Test'))

    expect(window.api.speech.testCloudKey).toHaveBeenCalledWith('groq')
    expect(container.textContent).toContain('Groq rejected this API key (401).')
    root.unmount()
  })
})

function findButton(scope: ParentNode, label: string): HTMLButtonElement {
  const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  )
  if (!button) {
    throw new Error(`Button "${label}" was not rendered`)
  }
  return button
}

async function clickButton(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click()
  })
  await act(async () => {
    await Promise.resolve()
  })
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setValue?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
