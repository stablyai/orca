// @vitest-environment happy-dom

import { act, useCallback, useState, type ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeveloperPermissionRequestResult } from '../../../../shared/developer-permissions-types'
import type { SpeechModelManifest } from '../../../../shared/speech-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import { handleVoiceDictationToggle, VoicePane as VoicePaneContent } from './VoicePane'
import { TooltipProvider } from '../ui/tooltip'

function VoicePane(props: ComponentProps<typeof VoicePaneContent>): React.JSX.Element {
  return (
    <TooltipProvider>
      <VoicePaneContent {...props} />
    </TooltipProvider>
  )
}

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

const deniedMicrophoneResult: DeveloperPermissionRequestResult = {
  id: 'microphone',
  status: 'denied',
  openedSystemSettings: false
}
const EMPTY_SPEECH_CATALOG: SpeechModelManifest[] = []

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
      speech: {
        getCatalog: vi.fn(async () => EMPTY_SPEECH_CATALOG),
        getOpenRouterApiKeyStatus: vi.fn(async () => ({ configured: false })),
        saveOpenRouterApiKey: vi.fn(async () => ({ configured: true })),
        clearOpenRouterApiKey: vi.fn(async () => ({ configured: false })),
        getOpenAiApiKeyStatus: vi.fn(async () => ({ configured: false })),
        saveOpenAiApiKey: vi.fn(async () => ({ configured: true })),
        clearOpenAiApiKey: vi.fn(async () => ({ configured: false })),
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
      <VoicePane settings={makeSettings(args.voiceEnabled)} updateSettings={args.updateSettings} />
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
        root.render(<VoicePane settings={{} as GlobalSettings} updateSettings={updateSettings} />)
      })
    }
    act(() => root.unmount())

    expect(window.api.speech.getCatalog).toHaveBeenCalledTimes(1)
    expect(refreshModelStates).toHaveBeenCalledTimes(1)
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
    window.api.speech.getOpenAiApiKeyStatus = vi.fn(async () => ({ configured: true }))
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
      root.render(<VoicePane settings={settingsWithKey(true)} updateSettings={updateSettings} />)
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

    // The user turns dictation off while the clear-key IPC is still in flight.
    await act(async () => {
      root.render(<VoicePane settings={settingsWithKey(false)} updateSettings={updateSettings} />)
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

describe('Voice cloud transcription keys', () => {
  const refreshModelStates = vi.fn()
  const settingsChanged = vi.fn()
  const catalog: SpeechModelManifest[] = [
    {
      id: 'openrouter-mai-transcribe-2',
      label: 'MAI-Transcribe 2',
      description: 'Microsoft multilingual transcription',
      provider: 'openrouter',
      type: 'openrouter',
      language: 'multilingual',
      sampleRate: 16000,
      streaming: false
    }
  ]
  function StatefulVoicePane({ modelId = '' }: { modelId?: string }): React.JSX.Element {
    const [settings, setSettings] = useState<GlobalSettings>(() => ({
      ...makeSettings(true),
      voice: {
        ...getDefaultVoiceSettings(),
        enabled: true,
        openAiApiKeyConfigured: true,
        sttModel: modelId
      }
    }))
    const updateSettings = useCallback((updates: Partial<GlobalSettings>) => {
      settingsChanged(updates)
      setSettings((current) => ({ ...current, ...updates }))
    }, [])
    return <VoicePane settings={settings} updateSettings={updateSettings} />
  }

  beforeEach(() => {
    vi.clearAllMocks()
    useShortcutLabelMock.mockReturnValue('Ctrl+Shift+Y')
    useAppStoreMock.mockImplementation((selector: (state: Record<string, unknown>) => unknown) =>
      selector({ modelStates: [], refreshModelStates, markFeatureTipsSeen: vi.fn() })
    )
    installWindowApi(async () => deniedMicrophoneResult)
    let openRouterConfigured = false
    Object.assign(window.api.speech, {
      getCatalog: vi.fn(async () => catalog),
      getOpenAiApiKeyStatus: vi.fn(async () => ({ configured: true })),
      getOpenRouterApiKeyStatus: vi.fn(async () => ({ configured: openRouterConfigured })),
      saveOpenRouterApiKey: vi.fn(async () => {
        openRouterConfigured = true
        return { configured: true }
      }),
      clearOpenRouterApiKey: vi.fn(async () => {
        openRouterConfigured = false
        return { configured: false }
      })
    })
  })

  afterEach(cleanup)

  it.each([
    ['openai', true],
    ['openai', false],
    ['openrouter', true],
    ['openrouter', false]
  ] as const)(
    'waits for %s status persistence (success: %s) before refreshing',
    async (provider, succeeds) => {
      const persistence = Promise.withResolvers<void>()
      window.api.speech.getOpenAiApiKeyStatus = vi.fn(async () => ({
        configured: provider === 'openai'
      }))
      window.api.speech.getOpenRouterApiKeyStatus = vi.fn(async () => ({
        configured: provider === 'openrouter'
      }))
      const updateSettings = vi.fn(() => persistence.promise)
      render(<VoicePane settings={makeSettings(true)} updateSettings={updateSettings} />)
      await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1))
      expect(refreshModelStates).toHaveBeenCalledTimes(1)
      await act(async () => {
        if (succeeds) {
          persistence.resolve()
        } else {
          persistence.reject(new Error('Settings unavailable'))
        }
      })
      expect(refreshModelStates).toHaveBeenCalledTimes(succeeds ? 2 : 1)
    }
  )

  it.each(['openai', 'openrouter'] as const)(
    'clears the %s key when catalog lookup fails',
    async (provider) => {
      window.api.speech.getCatalog = vi.fn(async () => {
        throw new Error('Catalog unavailable')
      })
      window.api.speech.getOpenAiApiKeyStatus = vi.fn(async () => ({ configured: true }))
      window.api.speech.getOpenRouterApiKeyStatus = vi.fn(async () => ({ configured: true }))
      const settings: GlobalSettings = {
        ...makeSettings(true),
        voice: {
          ...getDefaultVoiceSettings(),
          sttModel: 'unidentified-model',
          openAiApiKeyConfigured: true,
          openRouterApiKeyConfigured: true
        }
      }
      const updateSettings = vi.fn()
      render(<VoicePane settings={settings} updateSettings={updateSettings} />)
      fireEvent.click(
        screen.getByRole('button', {
          name: `Disconnect ${provider === 'openai' ? 'OpenAI' : 'OpenRouter'} API key`
        })
      )
      await waitFor(() =>
        expect(updateSettings).toHaveBeenCalledWith({
          voice: expect.objectContaining({
            sttModel: 'unidentified-model',
            openAiApiKeyConfigured: provider !== 'openai',
            openRouterApiKeyConfigured: provider !== 'openrouter'
          })
        })
      )
      expect(
        provider === 'openai'
          ? window.api.speech.clearOpenAiApiKey
          : window.api.speech.clearOpenRouterApiKey
      ).toHaveBeenCalledOnce()
    }
  )

  it.each(['openai', 'openrouter'] as const)(
    'rechecks the other provider after replacing an existing %s key',
    async (provider) => {
      const otherStatus = Promise.withResolvers<{ configured: boolean }>()
      window.api.speech.getOpenAiApiKeyStatus = vi.fn(() =>
        provider === 'openai' ? Promise.resolve({ configured: true }) : otherStatus.promise
      )
      window.api.speech.getOpenRouterApiKeyStatus = vi.fn(() =>
        provider === 'openrouter' ? Promise.resolve({ configured: true }) : otherStatus.promise
      )
      const settings: GlobalSettings = {
        ...makeSettings(true),
        voice: {
          ...getDefaultVoiceSettings(),
          sttModel: 'local-model',
          openAiApiKeyConfigured: provider === 'openai',
          openRouterApiKeyConfigured: provider === 'openrouter'
        }
      }
      const updateSettings = vi.fn()
      render(<VoicePane settings={settings} updateSettings={updateSettings} />)
      fireEvent.click(screen.getByRole('button', { name: 'Replace key' }))
      fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'replacement-key' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save Key' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      await act(async () => otherStatus.resolve({ configured: true }))

      expect(updateSettings).toHaveBeenLastCalledWith({
        voice: expect.objectContaining({
          sttModel: 'local-model',
          openAiApiKeyConfigured: true,
          openRouterApiKeyConfigured: true
        })
      })
    }
  )

  it.each(['openai', 'openrouter'] as const)(
    'waits for model provider evidence before clearing a %s key',
    async (provider) => {
      const pendingCatalog = Promise.withResolvers<SpeechModelManifest[]>()
      const model = { ...catalog[0], provider, type: provider }
      window.api.speech.getCatalog = vi.fn(() => pendingCatalog.promise)
      window.api.speech.getOpenAiApiKeyStatus = vi.fn(async () => ({ configured: true }))
      window.api.speech.getOpenRouterApiKeyStatus = vi.fn(async () => ({ configured: true }))
      const settings: GlobalSettings = {
        ...makeSettings(true),
        voice: {
          ...getDefaultVoiceSettings(),
          sttModel: model.id,
          openAiApiKeyConfigured: true,
          openRouterApiKeyConfigured: true
        }
      }
      const updateSettings = vi.fn()
      render(<VoicePane settings={settings} updateSettings={updateSettings} />)
      fireEvent.click(
        screen.getByRole('button', {
          name: `Disconnect ${provider === 'openai' ? 'OpenAI' : 'OpenRouter'} API key`
        })
      )
      expect(window.api.speech.clearOpenAiApiKey).not.toHaveBeenCalled()
      expect(window.api.speech.clearOpenRouterApiKey).not.toHaveBeenCalled()
      await act(async () => pendingCatalog.resolve([model]))

      expect(updateSettings).toHaveBeenCalledWith({
        voice: expect.objectContaining({
          sttModel: '',
          openAiApiKeyConfigured: provider !== 'openai',
          openRouterApiKeyConfigured: provider !== 'openrouter'
        })
      })
    }
  )

  it.each([
    ['openai', 'save'],
    ['openai', 'clear'],
    ['openai', 'replace'],
    ['openrouter', 'save'],
    ['openrouter', 'clear'],
    ['openrouter', 'replace']
  ] as const)(
    'ignores late provider status replies after %s key %s',
    async (provider, operation) => {
      const openAiStatus = Promise.withResolvers<{ configured: boolean }>()
      const openRouterStatus = Promise.withResolvers<{ configured: boolean }>()
      const persistence = Promise.withResolvers<void>()
      window.api.speech.getOpenAiApiKeyStatus = vi.fn(() => openAiStatus.promise)
      window.api.speech.getOpenRouterApiKeyStatus = vi.fn(() => openRouterStatus.promise)
      const model = {
        ...catalog[0],
        id: 'cloud-model',
        label: 'Cloud model',
        provider,
        type: provider
      }
      window.api.speech.getCatalog = vi.fn(async () => [model])
      const configured = operation !== 'save'
      const selectedModelId = operation === 'clear' ? '' : model.id
      const settings: GlobalSettings = {
        ...makeSettings(true),
        voice: {
          ...getDefaultVoiceSettings(),
          enabled: true,
          openAiApiKeyConfigured: configured,
          openRouterApiKeyConfigured: configured,
          sttModel: operation === 'clear' ? model.id : 'local-model'
        }
      }
      const updateSettings = vi.fn<(updates: Partial<GlobalSettings>) => Promise<void>>(
        () => persistence.promise
      )
      const view = render(<VoicePane settings={settings} updateSettings={updateSettings} />)
      fireEvent.keyDown(screen.getByRole('button', { name: 'Select Model' }), { key: 'Enter' })
      const option = await screen.findByRole('menuitem', { name: /Cloud model/ })
      if (operation !== 'clear') {
        fireEvent.click(option)
        fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'speech-key' } })
        fireEvent.click(screen.getByRole('button', { name: 'Save Key' }))
      } else {
        fireEvent.keyDown(option, { key: 'Escape' })
        fireEvent.click(
          screen.getByRole('button', {
            name: `Disconnect ${provider === 'openai' ? 'OpenAI' : 'OpenRouter'} API key`
          })
        )
      }
      await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1))
      expect(updateSettings).toHaveBeenLastCalledWith({
        voice: expect.objectContaining({ sttModel: selectedModelId })
      })

      // A model-state refresh can render old persisted settings before this write finishes.
      view.rerender(
        <VoicePane
          settings={{ ...settings, voice: { ...(settings.voice ?? getDefaultVoiceSettings()) } }}
          updateSettings={updateSettings}
        />
      )
      await act(async () => {
        openAiStatus.resolve({
          configured: provider === 'openai' ? operation !== 'clear' : !configured
        })
        openRouterStatus.resolve({
          configured: provider === 'openrouter' ? operation !== 'clear' : !configured
        })
      })
      expect(updateSettings).toHaveBeenCalledTimes(1)
      view.rerender(
        <VoicePane
          settings={{ ...settings, ...updateSettings.mock.calls[0][0] }}
          updateSettings={updateSettings}
        />
      )
      await act(async () => persistence.resolve())
      expect(updateSettings).toHaveBeenLastCalledWith({
        voice: expect.objectContaining({ sttModel: selectedModelId })
      })
    }
  )

  it.each(['Escape', 'Close'])('keeps pending key setup open on %s', async (dismiss) => {
    let finishSave: (status: { configured: boolean }) => void = () => {}
    window.api.speech.saveOpenRouterApiKey = vi.fn(
      () => new Promise<{ configured: boolean }>((resolve) => (finishSave = resolve))
    )
    render(<StatefulVoicePane />)
    fireEvent.click(screen.getByRole('button', { name: 'Add API key' }))
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-or-pending' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Key' }))
    if (dismiss === 'Escape') {
      fireEvent.keyDown(document, { key: 'Escape' })
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    }
    expect(screen.getByRole('dialog')).toBeTruthy()
    window.api.speech.getOpenRouterApiKeyStatus = vi.fn(async () => ({ configured: true }))
    finishSave({ configured: true })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('adds, replaces and disconnects the OpenRouter key independently of OpenAI', async () => {
    render(<StatefulVoicePane modelId="openai-gpt-4o-transcribe" />)
    fireEvent.click(screen.getByRole('button', { name: 'Add API key' }))
    const input = screen.getByLabelText<HTMLInputElement>('API Key')
    expect(input.type).toBe('password')
    expect(
      screen.getByText(
        'Audio is sent to OpenRouter only when an OpenRouter speech model is selected.'
      )
    ).toBeTruthy()
    fireEvent.change(input, { target: { value: 'sk-or-first' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Key' }))
    await waitFor(() =>
      expect(window.api.speech.saveOpenRouterApiKey).toHaveBeenCalledWith('sk-or-first')
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(settingsChanged).toHaveBeenLastCalledWith({
      voice: expect.objectContaining({
        openAiApiKeyConfigured: true,
        openRouterApiKeyConfigured: true,
        sttModel: 'openai-gpt-4o-transcribe'
      })
    })
    const replaceButtons = screen.getAllByRole('button', { name: 'Replace key' })
    fireEvent.click(replaceButtons[1])
    const replacement = screen.getByLabelText<HTMLInputElement>('API Key')
    expect(replacement.value).toBe('')
    fireEvent.change(replacement, { target: { value: 'sk-or-replacement' } })
    fireEvent.keyDown(replacement, { key: 'Enter' })
    await waitFor(() =>
      expect(window.api.speech.saveOpenRouterApiKey).toHaveBeenLastCalledWith('sk-or-replacement')
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect OpenRouter API key' }))
    await waitFor(() => expect(window.api.speech.clearOpenRouterApiKey).toHaveBeenCalledOnce())
    expect(settingsChanged).toHaveBeenLastCalledWith({
      voice: expect.objectContaining({
        openAiApiKeyConfigured: true,
        openRouterApiKeyConfigured: false,
        sttModel: 'openai-gpt-4o-transcribe'
      })
    })
    expect(window.api.speech.saveOpenAiApiKey).not.toHaveBeenCalled()
    expect(window.api.speech.clearOpenAiApiKey).not.toHaveBeenCalled()
  })

  it('clears the selected MAI model when disconnecting OpenRouter', async () => {
    window.api.speech.getOpenRouterApiKeyStatus = vi.fn(async () => ({ configured: true }))
    render(<StatefulVoicePane modelId="openrouter-mai-transcribe-2" />)
    const disconnect = await screen.findByRole('button', { name: 'Disconnect OpenRouter API key' })
    window.api.speech.getOpenRouterApiKeyStatus = vi.fn(async () => ({ configured: false }))
    fireEvent.click(disconnect)
    await waitFor(() =>
      expect(settingsChanged).toHaveBeenLastCalledWith({
        voice: expect.objectContaining({
          sttModel: '',
          openAiApiKeyConfigured: true,
          openRouterApiKeyConfigured: false
        })
      })
    )
  })
})
